// S11: the S2 read, run once per region (REGION label) at 20 rps. Locally there is one region.
import { assertAllowed } from '../lib/config.js';
import { readScenario } from '../lib/read.js';

assertAllowed('S11');
const s = readScenario({
  id: 'S11',
  title: 'GET /api/files/:id from one region',
  rps: [20, 10],
  duration: ['3m', '15s'],
  local:
    'Only one region exists locally, so there is no per-region comparison and no single versus multi layout; this is the S2 read at 20 rps and a baseline for the later three-region runs.',
});
export const options = s.options;
export const setup = s.setup;
export default s.run;
export const handleSummary = s.handleSummary;
