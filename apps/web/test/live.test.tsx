import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_OPEN_TIMEOUT_MS, useLiveFile } from '../src/live';
import { FakeEventSource, FILE_ID, fileJson, json, stubFetch } from './fakes';

function Probe() {
  const { data, live } = useLiveFile(FILE_ID);
  return (
    <p>
      {data?.status ?? 'loading'}|{live}
    </p>
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

const waitForStream = async () => {
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return FakeEventSource.instances[0] as FakeEventSource;
};

describe('useLiveFile', () => {
  it('follows SSE events and closes on a terminal status', async () => {
    let status = 'processing';
    const { calls } = stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson({ status })) });
    mount();
    const es = await waitForStream();
    expect(es.url).toBe(`/api/files/${FILE_ID}/events`);
    expect(es.init?.withCredentials).toBe(true);
    es.open();
    await screen.findByText('processing|sse');

    status = 'ready';
    act(() => es.emit('status', { id: FILE_ID, status: 'ready', width: 10, height: 10, lastError: null }));
    expect(es.closed).toBe(true);
    await screen.findByText('ready|closed');
    expect(calls.filter((c) => c.path === `/api/files/${FILE_ID}`).length).toBeGreaterThanOrEqual(2);
  });

  it('opens no stream for a file that is already terminal', async () => {
    stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson({ status: 'ready' })) });
    mount();
    await screen.findByText('ready|closed');
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('survives a server-side close (reconnect) and keeps SSE', async () => {
    stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson()) });
    mount();
    const es = await waitForStream();
    es.open();
    es.fail(false);
    es.open();
    es.fail(false);
    expect(es.closed).toBe(false);
    await screen.findByText('processing|sse');
  });

  it('falls back to polling every 2 s when the stream fails', async () => {
    let status = 'processing';
    const { calls } = stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson({ status })) });
    mount();
    const es = await waitForStream();
    act(() => es.fail(true));
    expect(es.closed).toBe(true);
    await screen.findByText('processing|polling');
    const count = () => calls.filter((c) => c.path === `/api/files/${FILE_ID}`).length;
    const before = count();
    status = 'ready';
    await waitFor(() => expect(count()).toBeGreaterThan(before), { timeout: 4000 });
    await screen.findByText('ready|closed');
    const settled = count();
    await new Promise((r) => setTimeout(r, 2300));
    expect(count()).toBe(settled); // polling stops on a terminal status
    expect(FakeEventSource.instances).toHaveLength(1); // and SSE is not reopened
  }, 15_000);

  it('falls back after repeated errors without a successful open', async () => {
    stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson()) });
    mount();
    const es = await waitForStream();
    act(() => {
      es.fail(false);
      es.fail(false);
      es.fail(false);
    });
    await screen.findByText('processing|polling');
  });

  it('falls back when the stream never opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson()) });
    mount();
    const es = await waitForStream();
    act(() => {
      vi.advanceTimersByTime(SSE_OPEN_TIMEOUT_MS);
    });
    expect(es.closed).toBe(true);
    await screen.findByText('processing|polling');
  });

  it('closes the connection on unmount', async () => {
    stubFetch({ [`GET /api/files/${FILE_ID}`]: () => json(fileJson()) });
    const view = mount();
    const es = await waitForStream();
    es.open();
    view.unmount();
    expect(FakeEventSource.open).toHaveLength(0);
    expect(es.closed).toBe(true);
  });
});
