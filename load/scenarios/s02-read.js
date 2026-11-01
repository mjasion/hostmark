// S2: GET /api/files/:id with a database read and presigned GET URLs for three variants.

import { assertAllowed } from '../lib/config.js';
import { readScenario } from '../lib/read.js';

assertAllowed('S2');
const s = readScenario({
  id: 'S2',
  title: 'Read GET /api/files/:id',
  rps: [50, 10],
  duration: ['3m', '15s'],
  local:
    'A database read (Postgres in the same Docker network, about 0.1 ms away) plus three local presign computations. Shows the cost of one query without network distance to the database.',
});
export const options = s.options;
export const setup = s.setup;
export default s.run;
export const handleSummary = s.handleSummary;
