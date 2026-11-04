export type Exec = (
  args: string[],
  options?: { input?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string }>;
export const CONFIGS: string[];
export const WORKER_SECRETS: string[];
export const REQUIRED: string[];
export const HYPERDRIVE_NAME: string;
export const DLQ_RETENTION_SECONDS: number;
export function bootstrap(input: {
  exec: Exec;
  env: Record<string, string | undefined>;
  root?: string;
  sha: string;
  log?: (line: string) => void;
}): Promise<void>;
export function secretValues(env: Record<string, string | undefined>): string[];
