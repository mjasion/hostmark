import { describeNodePortContracts } from '@hostmark/node-runtime/testing';

// Queue and storage run when REDIS_TEST_URL and S3_TEST_ENDPOINT point at the stack (see README); the image contract always runs.
describeNodePortContracts('local');
