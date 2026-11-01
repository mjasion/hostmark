import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { signedOut } from './session';
import { type UploadError, uploadFile, validateFile } from './upload';

export interface UploadItem {
  key: string;
  file: File;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  progress: number;
  fileId?: string;
  error?: string;
}

interface UploadsApi {
  items: UploadItem[];
  add: (files: Iterable<File>) => void;
  cancel: (key: string) => void;
  retry: (key: string) => void;
  dismiss: (key: string) => void;
}

const MAX_PARALLEL = 3;
const Context = createContext<UploadsApi | null>(null);

export function useUploads(): UploadsApi {
  const api = useContext(Context);
  if (!api) throw new Error('useUploads needs an UploadsProvider');
  return api;
}

let counter = 0;

/** Lives in the app layout so uploads keep running while the user opens a file. */
export function UploadsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const started = useRef(new Set<string>());

  const patch = useCallback((key: string, change: Partial<UploadItem>) => {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);

  const run = useCallback(
    async (item: UploadItem) => {
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      try {
        const fileId = await uploadFile(item.file, {
          signal: controller.signal,
          onProgress: (progress) => patch(item.key, { progress }),
          onCreated: (id) => patch(item.key, { fileId: id }),
        });
        patch(item.key, { status: 'done', progress: 1, fileId });
        void qc.invalidateQueries({ queryKey: ['files'] });
        void qc.invalidateQueries({ queryKey: ['stats'] });
      } catch (e) {
        const err = e as UploadError;
        if (err.unauthorized) signedOut(qc);
        patch(item.key, err.cancelled ? { status: 'cancelled' } : { status: 'error', error: err.message });
      } finally {
        controllers.current.delete(item.key);
      }
    },
    [patch, qc],
  );

  useEffect(() => {
    let slots = MAX_PARALLEL - items.filter((i) => i.status === 'uploading').length;
    for (const item of items) {
      if (slots <= 0) break;
      if (item.status === 'queued' && !started.current.has(item.key)) {
        started.current.add(item.key);
        slots--;
        patch(item.key, { status: 'uploading' });
        void run(item);
      }
    }
  }, [items, patch, run]);

  useEffect(() => {
    const live = controllers.current;
    return () => {
      for (const c of live.values()) c.abort();
    };
  }, []);

  const add = useCallback((files: Iterable<File>) => {
    const next: UploadItem[] = [];
    for (const file of files) {
      const error = validateFile(file);
      next.push({
        key: `u${++counter}`,
        file,
        status: error ? 'error' : 'queued',
        progress: 0,
        error: error ?? undefined,
      });
    }
    setItems((all) => [...next, ...all]);
  }, []);

  const cancel = useCallback(
    (key: string) => {
      const controller = controllers.current.get(key);
      if (controller) return controller.abort();
      patch(key, { status: 'cancelled' }); // still queued
      started.current.add(key);
    },
    [patch],
  );

  const retry = useCallback(
    (key: string) => {
      started.current.delete(key);
      patch(key, { status: 'queued', progress: 0, error: undefined, fileId: undefined });
    },
    [patch],
  );

  const dismiss = useCallback((key: string) => setItems((all) => all.filter((i) => i.key !== key)), []);

  return <Context.Provider value={{ items, add, cancel, retry, dismiss }}>{children}</Context.Provider>;
}
