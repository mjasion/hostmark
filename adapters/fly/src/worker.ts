import { runWorker } from '@hostmark/node-runtime/worker';
import { platform } from './platform';

runWorker(platform);
