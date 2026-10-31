import { JobMessage } from '@hostmark/contract';
import type { CoreDeps } from '../deps';
import type { JobHandler } from '../ports';
import { deleteFile } from './delete-file';
import { processImage } from './process-image';

export function createJobHandler(deps: CoreDeps): JobHandler {
  return async (raw, ctx) => {
    // Parse again: the platform hands over whatever was on the queue.
    const parsed = JobMessage.safeParse(raw);
    if (!parsed.success) {
      // Retrying cannot fix a malformed message, so log and ack.
      deps.telemetry.logger.error('invalid job message dropped', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'process_image':
        return processImage(deps, msg, ctx);
      case 'delete_file':
        return deleteFile(deps, msg);
    }
  };
}
