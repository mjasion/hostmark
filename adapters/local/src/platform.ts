import type { NodePlatform } from '@hostmark/node-runtime/platform';

export const platform: NodePlatform = {
  key: 'local-portable',
  // D104: the shared default is `production`; the stack runs on the placeholder secret of `.env.example`.
  env: (source) => ({ ENVIRONMENT: 'local', ...source }),
};
