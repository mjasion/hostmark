import { type JobMessage, originalKey, VARIANT_SIZES, variantKey } from '@hostmark/contract';
import { files, fileVariants } from '@hostmark/db';
import { withSpan } from '@hostmark/telemetry';
import { and, eq, isNull } from 'drizzle-orm';
import type { CoreDeps } from '../deps';

/**
 * D19: purge the objects of a `deleted` file. Keys are computed rather than read from `file_variants`, so
 * objects of an interrupted `process_image` go too. Idempotent.
 */
export async function deleteFile(deps: CoreDeps, msg: JobMessage): Promise<void> {
  const { db, storage, clock, telemetry } = deps;
  await withSpan(
    telemetry.tracer,
    'delete_file',
    async (span) => {
      span.setAttributes({ 'file.id': msg.fileId, 'job.id': msg.jobId });
      const [file] = await db
        .select({ userId: files.userId, status: files.status })
        .from(files)
        .where(eq(files.id, msg.fileId))
        .limit(1);
      if (file?.status !== 'deleted') {
        telemetry.logger.info('delete_file skipped', { fileId: msg.fileId, status: file?.status });
        return;
      }
      await storage.delete([
        originalKey(file.userId, msg.fileId),
        ...VARIANT_SIZES.map((size) => variantKey(file.userId, msg.fileId, size)),
      ]);
      await db.transaction(async (tx) => {
        await tx.delete(fileVariants).where(eq(fileVariants.fileId, msg.fileId));
        await tx
          .update(files)
          .set({ purgedAt: clock.now() })
          .where(and(eq(files.id, msg.fileId), eq(files.status, 'deleted'), isNull(files.purgedAt)));
      });
      telemetry.logger.info('delete_file done', { fileId: msg.fileId });
    },
    {},
  );
}
