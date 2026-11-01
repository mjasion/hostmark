import type { FileResponse, FileStatusEvent } from '@hostmark/contract';
import { FILE_STATUSES, SSE_FALLBACK_POLL_MS, TERMINAL_STATUSES } from '@hostmark/contract/constants';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { client } from './api';

/** If the stream sends no headers within this time (a buffering proxy, for example), poll instead. */
export const SSE_OPEN_TIMEOUT_MS = 10_000;
/** Consecutive errors without a successful open before giving up on SSE. */
const MAX_SSE_ERRORS = 3;
const EVENT_SOURCE_CLOSED = 2;

export const isTerminal = (status: string | undefined) =>
  status !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(status);

export type LiveMode = 'sse' | 'polling' | 'closed';

export const fileKey = (id: string) => ['file', id] as const;

/**
 * One file with live status (D20): `EventSource` first, polling every 2 s when SSE fails. The connection
 * closes on a terminal status and on unmount. The browser reconnects after the server's 60 s limit by itself.
 */
export function useLiveFile(id: string) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'sse' | 'polling'>('sse');
  const query = useQuery({
    queryKey: fileKey(id),
    queryFn: () => client.getFile(id),
    refetchInterval: (q) =>
      mode === 'polling' && !q.state.error && !isTerminal(q.state.data?.status)
        ? SSE_FALLBACK_POLL_MS
        : false,
  });
  const loaded = query.data !== undefined;
  const terminal = isTerminal(query.data?.status);

  useEffect(() => {
    if (!loaded || terminal || mode !== 'sse') return;
    const es = new EventSource(client.eventsUrl(id), { withCredentials: true });
    let errors = 0;
    const fallback = () => {
      clearTimeout(openTimer);
      es.close();
      setMode('polling');
    };
    const openTimer = setTimeout(fallback, SSE_OPEN_TIMEOUT_MS);
    es.onopen = () => {
      clearTimeout(openTimer);
      errors = 0;
    };
    es.addEventListener('status', (ev) => {
      // Shape-checked by hand: the server is trusted, and the schema would pull the route definitions in.
      const data = JSON.parse((ev as MessageEvent<string>).data) as Partial<FileStatusEvent>;
      if (!data.status || !(FILE_STATUSES as readonly string[]).includes(data.status)) return;
      const { status, width = null, height = null, lastError = null } = data;
      qc.setQueryData<FileResponse>(
        fileKey(id),
        (old) => old && { ...old, status, width, height, lastError },
      );
      if (isTerminal(status)) {
        es.close();
        // The event carries no variants or sizes; fetch the full record once.
        void qc.invalidateQueries({ queryKey: fileKey(id) });
        void qc.invalidateQueries({ queryKey: ['files'] });
      }
    });
    es.onerror = () => {
      errors++;
      if (es.readyState === EVENT_SOURCE_CLOSED || errors >= MAX_SSE_ERRORS) fallback();
    };
    return () => {
      clearTimeout(openTimer);
      es.close();
    };
  }, [id, loaded, terminal, mode, qc]);

  const live: LiveMode = terminal ? 'closed' : mode;
  return { ...query, live };
}
