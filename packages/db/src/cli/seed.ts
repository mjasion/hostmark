import { createNodeDb } from '../node';
import { seed } from '../seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const { db, close } = createNodeDb(url, { max: 1 });
try {
  const result = await seed(db, {
    apiKey: process.env.SEED_API_KEY || undefined,
    adminApiKey: process.env.SEED_ADMIN_API_KEY || undefined,
  });
  // Generated values exist nowhere else, so they are shown exactly once.
  if (result.generated.apiKey) console.log(`SEED_API_KEY=${result.apiKey}`);
  if (result.generated.adminApiKey) console.log(`SEED_ADMIN_API_KEY=${result.adminApiKey}`);
  console.log('seed applied');
} finally {
  await close();
}
