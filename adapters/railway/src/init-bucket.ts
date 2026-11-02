import { initBucket } from '@hostmark/node-runtime/init-bucket';
import { platform } from './platform';

await initBucket(platform);
