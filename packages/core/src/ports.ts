// Ports implemented by platform adapters (spec "Ports and adapters", as amended by D17).
// This module holds types and re-exports the dependency free errors; nothing else may be imported at
// runtime, so `@hostmark/core/ports` stays usable from `packages/image` and `packages/storage-s3`.

import type { JobMessage } from '@hostmark/contract';
import type { Database } from '@hostmark/db';

export { InvalidImageError } from './errors';

export interface Queue {
  send(msg: JobMessage, opts?: { delaySeconds?: number }): Promise<void>;
  /** Adapters chunk to platform limits. */
  sendBatch(msgs: JobMessage[]): Promise<void>;
  /** Absent when the platform cannot ping; reported as "unknown". */
  ping?(): Promise<void>;
}

// The consumer is inverted: the platform calls the handler, the handler does not poll.
export type JobHandler = (msg: JobMessage, ctx: JobContext) => Promise<void>;

export interface JobContext {
  /** 1..maxAttempts, as reported by the platform. */
  attempt: number;
  maxAttempts: number;
  receivedAt: Date;
  /** chaos=crash. Node: process.exit. Workers: throw without ack. */
  crash(): Promise<never>;
}

export interface ObjectStorage {
  /** `bytes` is the exact Content-Length that gets signed (D10). */
  presignPut(key: string, contentType: string, bytes: number, ttlSeconds: number): Promise<string>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  delete(keys: string[]): Promise<void>;
}

export interface ImageProcessor {
  readonly impl: 'wasm' | 'sharp' | 'platform';
  /** Throws InvalidImageError for undecodable input. */
  process(
    input: Uint8Array,
    sizes: number[],
  ): Promise<{
    width: number;
    height: number;
    variants: { size: number; body: Uint8Array; bytes: number }[];
  }>;
}

export interface Clock {
  now(): Date;
  /** chaos=slow; makes it testable. */
  sleep(ms: number): Promise<void>;
}

// Database: Drizzle with an injected driver, no custom abstraction.
export type Db = Database;
