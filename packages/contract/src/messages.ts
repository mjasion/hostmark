import { z } from '@hono/zod-openapi';
import { CHAOS_MODES, JOB_MESSAGE_VERSION, JOB_TYPES } from './constants';

export const Chaos = z.enum(CHAOS_MODES).openapi('Chaos');
export type Chaos = z.infer<typeof Chaos>;

export const JobType = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobType>;

export const JobMessage = z.object({
  v: z.literal(JOB_MESSAGE_VERSION),
  type: JobType,
  jobId: z.uuid(), // unique per send
  fileId: z.uuid(),
  enqueuedAt: z.iso.datetime(),
  traceparent: z.string().optional(), // W3C Trace Context
  tracestate: z.string().optional(),
  chaos: Chaos.default('none'),
});
/** Parsed message: `chaos` is always present. */
export type JobMessage = z.output<typeof JobMessage>;
/** What a producer may omit. */
export type JobMessageInput = z.input<typeof JobMessage>;
