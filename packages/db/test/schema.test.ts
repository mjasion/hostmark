import { FILE_STATUSES } from '@hostmark/contract';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { apiKeys, fileStatus, files, generateApiKey, hashApiKey } from '../src';

describe('schema', () => {
  it('keeps the file_status enum in step with the contract', () => {
    expect(fileStatus.enumValues).toEqual([...FILE_STATUSES]);
  });

  it('has the indexes the use cases rely on', () => {
    const names = getTableConfig(files).indexes.map((i) => i.config.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'files_user_created',
        'files_expires',
        'files_sha',
        'files_activity',
        'files_unpurged',
      ]),
    );
  });

  it('makes files.api_key_id nullable and api_keys.user_id required (D7, D14)', () => {
    expect(files.apiKeyId.notNull).toBe(false);
    expect(apiKeys.userId.notNull).toBe(true);
  });
});

describe('api keys', () => {
  it('hashes to sha256 hex', async () => {
    expect(await hashApiKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates distinct prefixed keys', () => {
    const a = generateApiKey();
    expect(a).toMatch(/^hm_[0-9a-f]{64}$/);
    expect(generateApiKey()).not.toBe(a);
  });
});
