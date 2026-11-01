import type { FileResponse } from '@hostmark/contract';
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, STATS_DAYS } from '@hostmark/contract/constants';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type DragEvent, useRef, useState } from 'react';
import { client, describeError, formatBytes } from '../api';
import { type UploadItem, useUploads } from '../uploads';

const PAGE_SIZE = 24;
const GALLERY_POLL_MS = 2000;

export function Panel() {
  return (
    <>
      <Usage />
      <Dropzone />
      <UploadList />
      <Gallery />
    </>
  );
}

function Usage() {
  const { data, error } = useQuery({ queryKey: ['stats'], queryFn: () => client.stats() });
  if (error) return <p className="muted">Usage unavailable: {describeError(error)}</p>;
  const totals = (data?.items ?? []).reduce(
    (t, d) => ({
      uploads: t.uploads + d.uploads,
      ready: t.ready + d.ready,
      failed: t.failed + d.failed,
      bytes: t.bytes + d.bytesIn,
    }),
    { uploads: 0, ready: 0, failed: 0, bytes: 0 },
  );
  return (
    <section aria-label="Platform usage" className="usage">
      <h2>Platform usage, last {STATS_DAYS} days</h2>
      <dl>
        <div>
          <dt>Uploads</dt>
          <dd>{data ? totals.uploads : '-'}</dd>
        </div>
        <div>
          <dt>Processed</dt>
          <dd>{data ? totals.ready : '-'}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{data ? totals.failed : '-'}</dd>
        </div>
        <div>
          <dt>Uploaded</dt>
          <dd>{data ? formatBytes(totals.bytes) : '-'}</dd>
        </div>
      </dl>
    </section>
  );
}

function Dropzone() {
  const { add } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    add(Array.from(e.dataTransfer.files));
  }

  return (
    <section
      aria-label="Upload"
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <p>Drop images here, or</p>
      <label className="button primary file-picker">
        Choose files
        <input
          ref={input}
          type="file"
          multiple
          accept={ALLOWED_CONTENT_TYPES.join(',')}
          onChange={(e) => {
            add(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = '';
          }}
        />
      </label>
      <p className="muted">JPEG, PNG or WebP, up to {MAX_UPLOAD_BYTES / 1_048_576} MiB each.</p>
    </section>
  );
}

function UploadList() {
  const { items } = useUploads();
  if (items.length === 0) return null;
  return (
    <ul className="uploads" aria-label="Uploads">
      {items.map((item) => (
        <UploadRow key={item.key} item={item} />
      ))}
    </ul>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const { cancel, retry, dismiss } = useUploads();
  const pct = Math.round(item.progress * 100);
  return (
    <li>
      <div className="row">
        <span className="name">{item.file.name}</span>
        <span className="muted">{formatBytes(item.file.size)}</span>
      </div>
      {(item.status === 'queued' || item.status === 'uploading') && (
        <div className="row">
          <progress max={100} value={pct} aria-label={`Upload progress of ${item.file.name}`} />
          <span className="muted">{item.status === 'queued' ? 'Waiting' : `${pct}%`}</span>
          <button type="button" onClick={() => cancel(item.key)}>
            Cancel
          </button>
        </div>
      )}
      {item.status === 'done' && (
        <div className="row">
          <span className="ok">Uploaded, processing.</span>
          {item.fileId && (
            <Link to="/app/files/$id" params={{ id: item.fileId }}>
              Open
            </Link>
          )}
          <button type="button" onClick={() => dismiss(item.key)}>
            Dismiss
          </button>
        </div>
      )}
      {item.status === 'error' && (
        <div className="row">
          <span role="alert" className="error">
            {item.error}
          </span>
          <button type="button" onClick={() => retry(item.key)}>
            Retry
          </button>
          <button type="button" onClick={() => dismiss(item.key)}>
            Dismiss
          </button>
        </div>
      )}
      {item.status === 'cancelled' && (
        <div className="row">
          <span className="muted">Cancelled.</span>
          <button type="button" onClick={() => retry(item.key)}>
            Retry
          </button>
          <button type="button" onClick={() => dismiss(item.key)}>
            Dismiss
          </button>
        </div>
      )}
    </li>
  );
}

function Gallery() {
  const query = useInfiniteQuery({
    queryKey: ['files'],
    queryFn: ({ pageParam }) => client.listFiles({ limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // One poll for the whole grid while something is being processed, never one SSE connection per item (D87).
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some((f) => f.status === 'queued' || f.status === 'processing'))
        ? GALLERY_POLL_MS
        : false,
  });

  if (query.isPending) return <p className="muted">Loading files...</p>;
  if (query.error)
    return (
      <p role="alert" className="error">
        {describeError(query.error)}
      </p>
    );

  // `pending_upload` rows are in the upload list above while their upload runs; one that was cancelled or
  // expired is left to the cleanup (D19, D86). A page may therefore hold fewer tiles than it has rows.
  const files = query.data.pages
    .flatMap((p) => p.items)
    .filter((f) => f.status !== 'deleted' && f.status !== 'pending_upload');
  if (files.length === 0 && !query.hasNextPage)
    return <p className="muted">No files yet. Upload an image to get started.</p>;

  // The list is newest first, so for equal content the oldest file is the last one with that hash.
  const originals = new Map<string, string>();
  for (const f of files) if (f.sha256) originals.set(f.sha256, f.id);

  return (
    <section aria-label="Files">
      <h2>Files</h2>
      {files.length === 0 && <p className="muted">No files on the loaded pages.</p>}
      <ul className="gallery">
        {files.map((f) => (
          <Thumb key={f.id} file={f} duplicate={!!f.sha256 && originals.get(f.sha256) !== f.id} />
        ))}
      </ul>
      {query.hasNextPage && (
        <p>
          <button type="button" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading...' : 'Load more'}
          </button>
        </p>
      )}
    </section>
  );
}

/** Presigned URLs change on every fetch; keep the first one so polling does not reload the image. */
function useStableUrl(url: string | undefined) {
  const ref = useRef(url);
  if (!ref.current) ref.current = url;
  return ref.current;
}

export function Thumb({ file, duplicate }: { file: FileResponse; duplicate: boolean }) {
  const variant = file.variants.find((v) => v.size === 128);
  const src = useStableUrl(variant?.url);
  return (
    <li>
      <Link to="/app/files/$id" params={{ id: file.id }} className="thumb">
        {file.status === 'ready' && src ? (
          <img
            src={src}
            alt={`Thumbnail of file ${file.id.slice(0, 8)}`}
            width={128}
            height={128}
            loading="lazy"
          />
        ) : (
          <span className={`placeholder ${file.status}`}>{statusLabel(file.status)}</span>
        )}
        <span className="caption">
          {file.status === 'ready' ? formatBytes(file.bytes) : statusLabel(file.status)}
          {duplicate && ' (duplicate)'}
        </span>
      </Link>
    </li>
  );
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending_upload':
      return 'Uploading';
    case 'queued':
      return 'Queued';
    case 'processing':
      return 'Processing';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}
