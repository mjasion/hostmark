// `pnpm check`: validates template.yaml offline and exits 1 on any problem.
import { checkTemplate } from './template-check';

const problems = checkTemplate();
if (problems.length) {
  for (const p of problems) console.error(`template.yaml: ${p}`);
  process.exit(1);
}
console.log('template.yaml: ok');
