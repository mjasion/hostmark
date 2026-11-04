import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@hostmark/contract/client';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { client, endSession, formatDate, isFileId, sessionSignal, trackStream } from '../src/api';
import { redirectWhenSignedOut, signedOut } from '../src/session';
import { FakeEventSource, FILE_ID, fileJson, json, problem } from './fakes';

describe('session scope (D302)', () => {
  it('drops an answer that arrives after its session ended, a 401 included', async () => {
    let answer: (res: Response) => void = () => {};
    // A server that answers although the browser aborted: the answer must still not count.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    const pending = client.getFile(FILE_ID).catch((e: unknown) => e);
    endSession();
    answer(problem(401, 'Unauthorized', 'Missing credentials'));
    const error = await pending;
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe('AbortError');
  });

  it('aborts the requests of the session and leaves the next session alone', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        if (init.signal) signals.push(init.signal);
        return json(fileJson());
      }),
    );
    const before = sessionSignal();
    await client.getFile(FILE_ID);
    endSession();
    expect(before.aborted).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    await expect(client.getFile(FILE_ID)).resolves.toMatchObject({ id: FILE_ID });
    expect(signals[1]?.aborted).toBe(false);
    expect(sessionSignal().aborted).toBe(false);
  });

  it('closes every tracked event stream, and only those still tracked', () => {
    const a = new FakeEventSource('/a') as unknown as EventSource;
    const b = new FakeEventSource('/b') as unknown as EventSource;
    trackStream(a);
    const untrack = trackStream(b);
    untrack();
    endSession();
    expect((a as unknown as FakeEventSource).closed).toBe(true);
    expect((b as unknown as FakeEventSource).closed).toBe(false);
  });

  it('ends on a 401: the handler closes the streams and aborts the requests of the session', () => {
    const es = new FakeEventSource('/s');
    trackStream(es as unknown as EventSource);
    const before = sessionSignal();
    const go = vi.fn();
    const qc = new QueryClient();
    redirectWhenSignedOut(qc, go);
    signedOut(qc);
    expect(es.closed).toBe(true);
    expect(before.aborted).toBe(true);
    expect(go).toHaveBeenCalledOnce();
  });
});

describe('isFileId', () => {
  it('accepts a UUID and nothing else', () => {
    expect(isFileId(FILE_ID)).toBe(true);
    expect(isFileId(FILE_ID.toUpperCase())).toBe(true);
    for (const id of ['not-a-uuid', '../../etc', '..%2f..%2fetc', `${FILE_ID}/x`, ` ${FILE_ID}`, ''])
      expect(isFileId(id), id).toBe(false);
  });
});

describe('dates', () => {
  it('are English, with a medium date and a short time', () => {
    // Noon UTC is the same calendar day in every time zone between UTC-11 and UTC+11.
    expect(formatDate('2026-01-08T12:00:00.000Z')).toMatch(/^Jan \d{1,2}, 2026, \d{1,2}:\d{2}\s[AP]M$/);
  });

  it('never use the browser default locale anywhere in the app', () => {
    const dir = join(__dirname, '..', 'src');
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8');
      // `toLocaleString()`, `toLocaleDateString(undefined, ...)`, `new Intl.NumberFormat()` and the like.
      expect(text, file).not.toMatch(/toLocale\w*String\(\s*(\)|undefined)|Intl\.\w+\(\s*(\)|undefined)/);
    }
  });
});
