// Runs the migrations and the idempotent seed against the shared database (D71) from the owner's machine.
// Needs DATABASE_URL; SEED_API_KEY and SEED_ADMIN_API_KEY are optional (absent: existing keys are kept, else generated).
import { seed } from '@hostmark/db';
import { createNodeDb, migrate } from '@hostmark/db/node';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

await migrate(url);
const node = createNodeDb(url, { max: 1 });
try {
  const result = await seed(node.db, {
    apiKey: process.env.SEED_API_KEY || undefined,
    adminApiKey: process.env.SEED_ADMIN_API_KEY || undefined,
  });
  if (result.generated.apiKey || result.generated.adminApiKey)
    console.log('Generated seed keys (shown once):', {
      apiKey: result.apiKey,
      adminApiKey: result.adminApiKey,
    });
  console.log('database ready');
} finally {
  await node.close();
}
