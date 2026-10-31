import {
  DOWNLOAD_URL_TTL_SECONDS,
  type FileResponse,
  type FileStatusEvent,
  VARIANT_SIZES,
  variantKey,
} from '@hostmark/contract';
import { type files, fileVariants } from '@hostmark/db';
import { inArray } from 'drizzle-orm';
import type { CoreDeps } from '../deps';

export type FileRow = typeof files.$inferSelect;

/**
 * Presigning is a local computation, so a list does one variants query and no storage round trip per item.
 * Variant URLs come from deterministic keys (D15); `bytes` comes from `file_variants`.
 */
export async function toFileResponses(deps: CoreDeps, rows: FileRow[]): Promise<FileResponse[]> {
  const readyIds = rows.filter((r) => r.status === 'ready').map((r) => r.id);
  const variantRows = readyIds.length
    ? await deps.db.select().from(fileVariants).where(inArray(fileVariants.fileId, readyIds))
    : [];
  const bytesBySize = new Map<string, number>();
  for (const v of variantRows) bytesBySize.set(`${v.fileId}/${v.size}`, v.bytes);

  return Promise.all(
    rows.map(async (row) => {
      const variants: FileResponse['variants'] = [];
      if (row.status === 'ready') {
        for (const size of VARIANT_SIZES) {
          const bytes = bytesBySize.get(`${row.id}/${size}`);
          if (bytes === undefined) continue;
          const url = await deps.storage.presignGet(
            variantKey(row.userId, row.id, size),
            DOWNLOAD_URL_TTL_SECONDS,
          );
          variants.push({ size, url, bytes });
        }
      }
      return {
        id: row.id,
        status: row.status,
        contentType: row.contentType,
        bytes: row.bytes,
        width: row.width,
        height: row.height,
        sha256: row.sha256,
        isPublic: row.isPublic,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        queuedAt: row.queuedAt?.toISOString() ?? null,
        readyAt: row.readyAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        variants,
      };
    }),
  );
}

export function toStatusEvent(row: FileRow): FileStatusEvent {
  return {
    id: row.id,
    status: row.status,
    width: row.width,
    height: row.height,
    lastError: row.lastError,
  };
}
