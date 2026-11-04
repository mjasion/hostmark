export const IMMUTABLE: string;
export const SHORT: string;
export const PAGE_PATHS: string[];
export function headersFile(options: { storageOrigin: string }): string;
export function storageOriginForBuild(env?: Record<string, string | undefined>, configText?: string): string;
