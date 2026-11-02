import type { JobMessage } from '@hostmark/contract';
import { createJobHandler } from '@hostmark/core';
import type { Bindings } from './env';
import { getImageProcessor } from './images';
import { createWorkersCachePurger } from './purge';
import { consumeBatch } from './queue';
import { createScope } from './runtime';

export default {
  async queue(batch: MessageBatch<JobMessage>, env: Bindings): Promise<void> {
    const scope = createScope(env, {
      service: 'worker',
      images: getImageProcessor(),
      purger: createWorkersCachePurger(env.MEDIA),
    });
    try {
      await consumeBatch(batch, {
        handler: createJobHandler(scope.deps),
        log: (msg, fields) => scope.deps.telemetry.logger.warn(msg, fields),
      });
    } finally {
      await scope.close();
    }
  },
} satisfies ExportedHandler<Bindings, JobMessage>;
