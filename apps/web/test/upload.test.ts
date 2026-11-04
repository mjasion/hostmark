import { MAX_UPLOAD_BYTES } from '@hostmark/contract/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { endSession } from '../src/api';
import { CANCELLED_WHILE_COMPLETING, UploadError, uploadFile, validateFile } from '../src/upload';
import { createFile, FakeXHR, FILE_ID, fileJson, json, problem, stubFetch } from './fakes';

const future = () => new Date(Date.now() + 600_000).toISOString();
const created = (expiresAt = future()) =>
  json(
    {
      fileId: FILE_ID,
      uploadUrl: 'http://storage.test/put?sig=1',
      uploadHeaders: { 'content-type': 'image/png' },
      expiresAt,
    },
    201,
  );

beforeEach(() => {
  FakeXHR.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

const hooks = (signal = new AbortController().signal) => ({
  onProgress: vi.fn(),
  onCreated: vi.fn(),
  signal,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('validateFile', () => {
  it('applies the contract limits', () => {
    expect(validateFile({ type: 'image/png', size: 10 })).toBeNull();
    expect(validateFile({ type: 'image/gif', size: 10 })).toMatch(/JPEG, PNG and WebP/);
    expect(validateFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(validateFile({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 })).toMatch(/larger than 10 MiB/);
    expect(validateFile({ type: 'image/png', size: MAX_UPLOAD_BYTES })).toBeNull();
  });
});

describe('uploadFile', () => {
  it('creates, PUTs with exactly the presigned headers and completes', async () => {
    const { calls } = stubFetch({
      'POST /api/uploads': () => created(),
      [`POST /api/uploads/${FILE_ID}/complete`]: () => json(fileJson({ status: 'queued' })),
    });
    const h = hooks();
    const done = uploadFile(createFile(), h);
    await tick();
    const xhr = FakeXHR.last();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('http://storage.test/put?sig=1');
    expect(xhr.headers).toEqual({ 'content-type': 'image/png' });
    xhr.progress(617, 1234);
    expect(h.onProgress).toHaveBeenCalledWith(0.5);
    xhr.finish(200);
    await expect(done).resolves.toBe(FILE_ID);
    expect(h.onCreated).toHaveBeenCalledWith(FILE_ID);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/uploads',
      `POST /api/uploads/${FILE_ID}/complete`,
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ contentType: 'image/png', bytes: 1234 });
  });

  it('does not call the API for a file that fails local validation', async () => {
    const { fn } = stubFetch({});
    await expect(uploadFile(createFile('a.gif', 'image/gif'), hooks())).rejects.toThrow(/JPEG, PNG and WebP/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('explains a rejected PUT (expired link)', async () => {
    stubFetch({ 'POST /api/uploads': () => created() });
    const done = uploadFile(createFile(), hooks());
    done.catch(() => {});
    await tick();
    FakeXHR.last().finish(403);
    await expect(done).rejects.toThrow(/expired or was rejected/);
  });

  it('explains other storage failures and network errors', async () => {
    stubFetch({ 'POST /api/uploads': () => created() });
    const a = uploadFile(createFile(), hooks());
    a.catch(() => {});
    await tick();
    FakeXHR.last().finish(500);
    await expect(a).rejects.toThrow('Storage rejected the upload (HTTP 500).');

    const b = uploadFile(createFile(), hooks());
    b.catch(() => {});
    await tick();
    FakeXHR.last().onerror?.();
    await expect(b).rejects.toThrow(/Network error/);
  });

  it('refuses an already expired link without sending the file', async () => {
    stubFetch({ 'POST /api/uploads': () => created('2020-01-01T00:00:00.000Z') });
    await expect(uploadFile(createFile(), hooks())).rejects.toThrow(/already expired/);
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('can be cancelled during the PUT', async () => {
    stubFetch({ 'POST /api/uploads': () => created() });
    const controller = new AbortController();
    const done = uploadFile(createFile(), hooks(controller.signal));
    done.catch(() => {});
    await tick();
    controller.abort();
    const err = await done.catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.cancelled).toBe(true);
    expect(FakeXHR.last().aborted).toBe(true);
  });

  it('shows the problem detail of a 413 from the server', async () => {
    stubFetch({ 'POST /api/uploads': () => problem(413, 'Payload Too Large', 'Limit is 10485760 bytes') });
    await expect(uploadFile(createFile(), hooks())).rejects.toThrow('Limit is 10485760 bytes');
  });

  it('aborts a running complete on cancel and says the file may still be processed (D302)', async () => {
    const { calls } = stubFetch({
      'POST /api/uploads': () => created(),
      [`POST /api/uploads/${FILE_ID}/complete`]: () => new Promise<Response>(() => {}),
    });
    const controller = new AbortController();
    const done = uploadFile(createFile(), hooks(controller.signal));
    done.catch(() => {});
    await tick();
    FakeXHR.last().finish(200);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort();
    const err = await done.catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.cancelled).toBe(true);
    expect(err.message).toBe(CANCELLED_WHILE_COMPLETING);
    expect(calls[1]?.init.signal?.aborted).toBe(true);
  });

  it('does not send complete when cancelled right after the PUT', async () => {
    const { calls } = stubFetch({ 'POST /api/uploads': () => created() });
    const controller = new AbortController();
    const done = uploadFile(createFile(), hooks(controller.signal));
    done.catch(() => {});
    await tick();
    // The PUT has loaded, so aborting the XHR does nothing; the check before complete must catch it.
    FakeXHR.last().finish(200);
    controller.abort();
    const err = await done.catch((e) => e);
    expect(err.cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('is aborted by the end of the session, during the PUT', async () => {
    stubFetch({ 'POST /api/uploads': () => created() });
    const done = uploadFile(createFile(), hooks());
    done.catch(() => {});
    await tick();
    endSession();
    const err = await done.catch((e) => e);
    expect(err.cancelled).toBe(true);
    expect(FakeXHR.last().aborted).toBe(true);
  });

  describe('retry', () => {
    const failure = async (routes: Parameters<typeof stubFetch>[0], put?: number) => {
      stubFetch({ 'POST /api/uploads': () => created(), ...routes });
      FakeXHR.reset();
      const done = uploadFile(createFile(), hooks());
      done.catch(() => {});
      if (put !== undefined) {
        await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
        FakeXHR.last().finish(put);
      }
      return (await done.catch((e) => e)) as UploadError;
    };
    const complete = `POST /api/uploads/${FILE_ID}/complete`;

    it('is not offered for a file the API refused (type, size)', async () => {
      for (const status of [400, 413, 415]) {
        const err = await failure({ 'POST /api/uploads': () => problem(status, 'Refused', 'No') });
        expect(err.retryable, String(status)).toBe(false);
      }
      const big = await failure({ [complete]: () => problem(413, 'Payload Too Large', 'Too big') }, 200);
      expect(big.retryable).toBe(false);
      const local = await uploadFile(createFile('a.gif', 'image/gif'), hooks()).catch((e) => e);
      expect(local.retryable).toBe(false);
    });

    it('is offered for failures a new attempt can get past', async () => {
      expect((await failure({ 'POST /api/uploads': () => problem(500, 'Error', 'Down') })).retryable).toBe(
        true,
      );
      expect((await failure({ 'POST /api/uploads': () => problem(503, 'Error', 'Down') })).retryable).toBe(
        true,
      );
      expect((await failure({}, 403)).retryable).toBe(true);
      expect((await failure({}, 500)).retryable).toBe(true);
      expect(
        (await failure({ [complete]: () => problem(409, 'Conflict', 'No object') }, 200)).retryable,
      ).toBe(true);
      expect((await failure({ [complete]: () => problem(503, 'Unavailable', 'Queue') }, 200)).retryable).toBe(
        true,
      );
    });
  });

  it('shows the problem detail when completing fails', async () => {
    stubFetch({
      'POST /api/uploads': () => created(),
      [`POST /api/uploads/${FILE_ID}/complete`]: () => problem(409, 'Conflict', 'No object was uploaded'),
    });
    const done = uploadFile(createFile(), hooks());
    done.catch(() => {});
    await tick();
    FakeXHR.last().finish(200);
    await expect(done).rejects.toThrow('No object was uploaded');
  });
});
