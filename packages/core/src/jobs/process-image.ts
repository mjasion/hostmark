import {
  CHAOS_SLOW_MS,
  type JobMessage,
  MAX_ATTEMPTS,
  originalKey,
  VARIANT_SIZES,
  variantKey,
} from '@hostmark/contract';
import { files, fileVariants } from '@hostmark/db';
import { linkFromMessage, withSpan } from '@hostmark/telemetry';
import { SpanKind } from '@opentelemetry/api';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { CoreDeps } from '../deps';
import { InvalidImageError } from '../errors';
import type { JobContext } from '../ports';

const MAX_ERROR_LENGTH = 500;

/** Messages that are safe to show to the user through `files.last_error`; every other error is generic. */
class PublicError extends Error {}
const GENERIC_ERROR = 'processing failed';

type CommitOutcome = 'committed' | 'deleted' | 'superseded';

interface Processed {
  width: number;
  height: number;
  variants: { size: number; bytes: number }[];
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Spec "Worker and scheduler": seven steps, each a child span, with D17 retry and chaos rules. */
export async function processImage(deps: CoreDeps, msg: JobMessage, ctx: JobContext): Promise<void> {
  const { db, storage, images, clock, telemetry } = deps;
  const { tracer, logger, metrics } = telemetry;
  const started = clock.now();
  const attrs = { 'job.type': 'process_image' };
  const link = linkFromMessage(msg);

  await withSpan(
    tracer,
    'process_image',
    async (root) => {
      root.setAttributes({ 'file.id': msg.fileId, 'job.id': msg.jobId, 'job.attempt': ctx.attempt });

      // 1. Claim (idempotency): no row means ready, failed or deleted, so ack without work.
      const claimed = await withSpan(tracer, 'process_image.claim', async () => {
        const [row] = await db
          .update(files)
          .set({ status: 'processing', attempts: sql`${files.attempts} + 1`, lastActivityAt: started })
          .where(
            and(
              eq(files.id, msg.fileId),
              inArray(files.status, ['queued', 'processing']),
              isNull(files.deletedAt),
            ),
          )
          .returning({ attempts: files.attempts, userId: files.userId, queuedAt: files.queuedAt });
        return row;
      });
      if (!claimed) {
        await cleanupAfterMissedClaim(deps, msg);
        return;
      }
      const { userId } = claimed;
      // Once per job: later deliveries would measure retry backoff, not queue latency.
      if (claimed.attempts === 1)
        metrics.enqueueToStartMs.record(Math.max(0, started.getTime() - Date.parse(msg.enqueuedAt)), attrs);

      // The file's own counter is the same on every platform; ctx.attempt is not (D17).
      if (msg.chaos === 'crash' && claimed.attempts === 1) await ctx.crash();

      try {
        if (msg.chaos === 'fail') throw new PublicError('chaos=fail');
        if (msg.chaos === 'slow') await clock.sleep(CHAOS_SLOW_MS);

        // 2. Download
        const original = await withSpan(tracer, 'process_image.download', async () => {
          const body = await storage.get(originalKey(userId, msg.fileId));
          if (!body) throw new PublicError('original object is missing');
          return body;
        });

        // 3. Hash and deduplicate within the same user
        const sha256 = await withSpan(tracer, 'process_image.hash', async (span) => {
          const digest = await crypto.subtle.digest('SHA-256', original as BufferSource);
          const hex = toHex(new Uint8Array(digest));
          span.setAttribute('file.sha256', hex);
          return hex;
        });
        const deduplicated = await withSpan(tracer, 'process_image.dedup', async (span) => {
          const result = await copyFromDuplicate(deps, userId, msg.fileId, sha256);
          span.setAttribute('dedup.hit', result !== null);
          return result;
        });

        let result: Processed;
        if (deduplicated) {
          result = deduplicated;
        } else {
          // 4. Decode, strip EXIF, encode
          const processed = await withSpan(tracer, 'process_image.transform', () =>
            images.process(original, [...VARIANT_SIZES]),
          );
          // 5. Write variants; keys are deterministic so a redelivery overwrites the same objects
          await withSpan(tracer, 'process_image.write_variants', () =>
            Promise.all(
              processed.variants.map((v) =>
                storage.put(variantKey(userId, msg.fileId, v.size), v.body, 'image/webp'),
              ),
            ),
          );
          result = {
            width: processed.width,
            height: processed.height,
            variants: processed.variants.map((v) => ({ size: v.size, bytes: v.bytes })),
          };
        }

        // 6. One transaction, conditional on `processing` so a racing delete cannot be undone
        const readyAt = clock.now();
        const outcome = await withSpan(
          tracer,
          'process_image.commit',
          async (): Promise<CommitOutcome> =>
            db.transaction(async (tx) => {
              const updated = await tx
                .update(files)
                .set({
                  status: 'ready',
                  width: result.width,
                  height: result.height,
                  sha256,
                  readyAt,
                  lastError: null,
                  lastActivityAt: readyAt,
                })
                .where(and(eq(files.id, msg.fileId), eq(files.status, 'processing')))
                .returning({ id: files.id });
              if (updated.length === 0) {
                // No row is also what an overlapping delivery that committed first looks like (D54).
                const [current] = await tx
                  .select({ status: files.status })
                  .from(files)
                  .where(eq(files.id, msg.fileId));
                return current?.status === 'deleted' ? 'deleted' : 'superseded';
              }
              await tx
                .insert(fileVariants)
                .values(
                  result.variants.map((v) => ({
                    fileId: msg.fileId,
                    size: v.size,
                    storageKey: variantKey(userId, msg.fileId, v.size),
                    bytes: v.bytes,
                  })),
                )
                .onConflictDoUpdate({
                  target: [fileVariants.fileId, fileVariants.size],
                  set: { storageKey: sql`excluded.storage_key`, bytes: sql`excluded.bytes` },
                });
              return 'committed';
            }),
        );

        // 7. Ack (by returning) and record metrics
        await withSpan(tracer, 'process_image.ack', async () => {
          if (outcome === 'deleted') {
            // The purge may already have run, so nobody else removes these objects. A failure here
            // propagates: the redelivery finds the deleted file and cleans up again.
            await deleteVariants(deps, userId, msg.fileId).catch((cleanupErr: unknown) => {
              logger.warn('process_image could not remove the variants of a deleted file, will retry', {
                fileId: msg.fileId,
                error: cleanupErr,
              });
              throw cleanupErr;
            });
            logger.info('process_image finished without effect, file was deleted', { fileId: msg.fileId });
            return;
          }
          if (outcome === 'superseded') {
            logger.info('process_image finished without effect, the file is already ready or failed', {
              fileId: msg.fileId,
            });
            return;
          }
          const end = clock.now();
          metrics.processingDurationMs.record(end.getTime() - started.getTime(), attrs);
          if (claimed.queuedAt)
            metrics.uploadToReadyMs.record(readyAt.getTime() - claimed.queuedAt.getTime(), attrs);
          logger.info('process_image done', {
            fileId: msg.fileId,
            attempt: ctx.attempt,
            dedup: deduplicated !== null,
          });
        });
      } catch (err) {
        const rethrow = await handleFailure(deps, msg, ctx, claimed.attempts, err);
        if (!rethrow) return;
        throw err;
      }
    },
    { kind: SpanKind.CONSUMER, links: link ? [link] : [] },
  );
}

const deleteVariants = (deps: CoreDeps, userId: string, fileId: string): Promise<void> =>
  deps.storage.delete(VARIANT_SIZES.map((size) => variantKey(userId, fileId, size)));

/** No row to claim: ready, failed, deleted or unknown. A deleted file may still have stray variants (M1). */
async function cleanupAfterMissedClaim(deps: CoreDeps, msg: JobMessage): Promise<void> {
  const { db, telemetry } = deps;
  const [row] = await db
    .select({ status: files.status, userId: files.userId })
    .from(files)
    .where(eq(files.id, msg.fileId));
  if (row?.status === 'deleted') {
    // delete_file may have run already, so a variant written after it is never removed by anyone else.
    await deleteVariants(deps, row.userId, msg.fileId).catch((err: unknown) => {
      telemetry.logger.warn('process_image could not remove the variants of a deleted file, will retry', {
        fileId: msg.fileId,
        error: err,
      });
      throw err;
    });
  }
  telemetry.logger.info('process_image skipped, nothing to claim', { fileId: msg.fileId, jobId: msg.jobId });
}

/** Copies another ready file's objects of the same user, or returns null to process normally. */
async function copyFromDuplicate(
  deps: CoreDeps,
  userId: string,
  fileId: string,
  sha256: string,
): Promise<Processed | null> {
  const { db, storage } = deps;
  const [source] = await db
    .select({ id: files.id, width: files.width, height: files.height })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        eq(files.sha256, sha256),
        eq(files.status, 'ready'),
        isNull(files.deletedAt),
        ne(files.id, fileId),
      ),
    )
    .limit(1);
  if (!source || source.width === null || source.height === null) return null;

  const sourceVariants = await db.select().from(fileVariants).where(eq(fileVariants.fileId, source.id));
  if (!VARIANT_SIZES.every((size) => sourceVariants.some((v) => v.size === size))) return null;

  const bodies = await Promise.all(sourceVariants.map((v) => storage.get(v.storageKey)));
  // The source's objects may be gone (purge racing); fall back to processing.
  if (bodies.some((b) => b === null)) return null;
  await Promise.all(
    sourceVariants.map((v, i) =>
      storage.put(variantKey(userId, fileId, v.size), bodies[i] as Uint8Array, 'image/webp'),
    ),
  );
  return {
    width: source.width,
    height: source.height,
    variants: sourceVariants.map((v) => ({ size: v.size, bytes: v.bytes })),
  };
}

/**
 * Errors in steps 2 to 6 (D17): record, then fail permanently or let the platform retry. Returns whether the
 * caller rethrows: not for bad input, and not when only the file's own counter made the job final, because the
 * platform would spend a retry on a row that is already failed (D72).
 */
async function handleFailure(
  deps: CoreDeps,
  msg: JobMessage,
  ctx: JobContext,
  claimedAttempts: number,
  err: unknown,
): Promise<boolean> {
  const { db, clock, telemetry } = deps;
  const { logger, metrics } = telemetry;
  const attrs = { 'job.type': 'process_image' };
  const permanent = err instanceof InvalidImageError;
  // The platform's counter restarts on requeued messages, so the file's own counter is a second bound.
  const final = permanent || ctx.attempt >= ctx.maxAttempts || claimedAttempts >= MAX_ATTEMPTS;
  // Raw messages can carry object keys or S3 response snippets; they stay in the log (D72).
  const lastError = (permanent || err instanceof PublicError ? (err as Error).message : GENERIC_ERROR).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const detail = err instanceof Error ? err : new Error(String(err));

  const updated = await db
    .update(files)
    .set({ lastError, lastActivityAt: clock.now(), ...(final ? { status: 'failed' as const } : {}) })
    .where(and(eq(files.id, msg.fileId), eq(files.status, 'processing')))
    .returning({ id: files.id });

  if (permanent) {
    // The cause tells bad input from a decoder fault that was classified as bad input.
    logger.warn('process_image failed permanently', {
      fileId: msg.fileId,
      error: detail,
      cause: detail.cause instanceof Error ? `${detail.cause.name}: ${detail.cause.message}` : detail.cause,
    });
    return false;
  }
  if (final) {
    if (updated.length > 0) metrics.jobsDeadLettered.add(1, attrs);
    logger.error('process_image dead lettered', { fileId: msg.fileId, attempt: ctx.attempt, error: detail });
    // Acknowledge early only when this attempt recorded the failure on the row. Without a row update (a delete
    // won, so the failure may be a variant cleanup) the retry must happen: it cleans up on the claim miss (D54).
    return ctx.attempt >= ctx.maxAttempts || updated.length === 0;
  }
  metrics.jobsRetried.add(1, attrs);
  logger.warn('process_image will be retried', { fileId: msg.fileId, attempt: ctx.attempt, error: detail });
  return true;
}
