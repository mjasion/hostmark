import type { VariantSize } from './constants';

// Deterministic storage keys (D15); a repeated write overwrites the same object.
export const originalKey = (userId: string, fileId: string): string => `originals/${userId}/${fileId}`;

export const variantKey = (userId: string, fileId: string, size: VariantSize | number): string =>
  `variants/${userId}/${fileId}/${size}.webp`;
