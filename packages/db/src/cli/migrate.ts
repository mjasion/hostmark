import { migrate } from '../node';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
await migrate(url);
console.log('migrations applied');
