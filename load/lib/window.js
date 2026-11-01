// The files a run created, seen through the API only: list pages newest first (ids are UUIDv7, so they sort by
// time) until a page reaches the id that was newest before the run.
import { listFiles } from './api.js';

/** @returns {{ total: number, byStatus: Record<string, number>, nonTerminal: number, maxAttempts: number } | null} */
export function windowSnapshot(key, boundaryId, { pageLimit = 100, maxPages = 50 } = {}) {
  const byStatus = {};
  let total = 0;
  let maxAttempts = 0;
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const res = listFiles(key, `limit=${pageLimit}${cursor ? `&cursor=${cursor}` : ''}`, {
      name: 'GET /api/files (window)',
    });
    if (res.status !== 200) return null;
    const body = res.json();
    let reachedBoundary = false;
    for (const f of body.items) {
      if (boundaryId && f.id <= boundaryId) {
        reachedBoundary = true;
        break;
      }
      total++;
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
      if (f.attempts > maxAttempts) maxAttempts = f.attempts;
    }
    if (reachedBoundary || !body.nextCursor) break;
    cursor = body.nextCursor;
  }
  const nonTerminal = total - (byStatus.ready ?? 0) - (byStatus.failed ?? 0) - (byStatus.deleted ?? 0);
  return { total, byStatus, nonTerminal, maxAttempts };
}
