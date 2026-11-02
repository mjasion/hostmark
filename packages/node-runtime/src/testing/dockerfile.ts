import { readFileSync } from 'node:fs';

/**
 * Every Node adapter builds the same image as adapters/local. The only lines that may differ are the adapter's own
 * name and the build-argument defaults of the RUM attributes. Returns the adapter's Dockerfile with those normalised.
 */
export function normalizedDockerfile(file: URL | string, adapter: string): string {
  return readFileSync(file, 'utf8')
    .replaceAll(`adapters/${adapter}`, 'adapters/ADAPTER')
    .replaceAll(`adapter-${adapter}`, 'adapter-ADAPTER')
    .replace(/^ARG HOSTMARK_PLATFORM=.*$/m, 'ARG HOSTMARK_PLATFORM=X')
    .replace(/^ARG HOSTMARK_REGION=.*$/m, 'ARG HOSTMARK_REGION=X')
    .replace(/^ARG APP_VERSION=.*$/m, 'ARG APP_VERSION=X');
}
