// Writes the JPEGs that scripts/measure-pixels.sh sends to the image Worker. Output: <outDir>/<megapixels>.jpg
//   node --import tsx scripts/measure-pixels-fixtures.ts <outDir> [megapixels,...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeJpeg } from '../test/fixtures/jpeg';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: measure-pixels-fixtures.ts <outDir> [megapixels,...]');
mkdirSync(outDir, { recursive: true });
const sizes = (process.argv[3] ?? '0.003,2,4,6,8,10,12,14,16,20,25').split(',').map(Number);
for (const mp of sizes) {
  const width = Math.max(8, Math.round(Math.sqrt((mp * 1e6 * 4) / 3)));
  const height = Math.max(8, Math.round(Math.sqrt((mp * 1e6 * 3) / 4)));
  const jpeg = await makeJpeg(width, height);
  writeFileSync(join(outDir, `${mp}.jpg`), jpeg);
  console.log(`${mp} MP: ${width}x${height}, ${jpeg.length} bytes`);
}
