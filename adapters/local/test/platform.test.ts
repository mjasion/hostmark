import { RUM_PLATFORMS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { platform } from '../src/platform';

describe('platform key', () => {
  it('is local-portable and starts with a platform of the closed RUM list', () => {
    expect(platform.key).toBe('local-portable');
    expect(RUM_PLATFORMS).toContain(platform.key.split('-')[0]);
  });
});
