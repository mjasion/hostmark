export interface Pixels {
  /** RGBA, 4 bytes per pixel, tightly packed and not a view into a larger buffer. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** True when the orientation swaps the axes (EXIF 5..8). */
export const swapsAxes = (orientation: number): boolean => orientation >= 5;

/**
 * Moves pixels to their upright position for EXIF orientations 1..8.
 * Returns the input untouched for 1; otherwise a new buffer.
 */
export function applyOrientation(src: Pixels, orientation: number): Pixels {
  if (orientation < 2 || orientation > 8) return src;
  const { width: sw, height: sh } = src;
  const swap = swapsAxes(orientation);
  const dw = swap ? sh : sw;
  const dh = swap ? sw : sh;
  const from = new Uint32Array(src.data.buffer, src.data.byteOffset, sw * sh);
  const out = new Uint32Array(dw * dh);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2:
          sx = sw - 1 - dx;
          sy = dy;
          break;
        case 3:
          sx = sw - 1 - dx;
          sy = sh - 1 - dy;
          break;
        case 4:
          sx = dx;
          sy = sh - 1 - dy;
          break;
        case 5:
          sx = dy;
          sy = dx;
          break;
        case 6:
          sx = dy;
          sy = sh - 1 - dx;
          break;
        case 7:
          sx = sw - 1 - dy;
          sy = sh - 1 - dx;
          break;
        default:
          sx = sw - 1 - dy;
          sy = dx;
          break;
      }
      out[dy * dw + dx] = from[sy * sw + sx] as number;
    }
  }
  return { data: new Uint8ClampedArray(out.buffer), width: dw, height: dh };
}
