import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { client, describeError, formatBytes } from '../api';
import { fileKey, useLiveFile } from '../live';
import { statusLabel } from './Panel';

/** The variant's size as the worker computes it: the longer side is `min(size, longest)`. */
export function fitInside(width: number, height: number, size: number) {
  const longest = Math.max(width, height);
  if (size >= longest) return { width, height };
  const scale = size / longest;
  return {
    width: width >= height ? size : Math.max(1, Math.round(width * scale)),
    height: height > width ? size : Math.max(1, Math.round(height * scale)),
  };
}

export function FileDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: file, error, isPending, live } = useLiveFile(id);
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({
    mutationFn: (isPublic: boolean) => client.updateFile(id, { isPublic }),
    onSuccess: (updated) => qc.setQueryData(fileKey(id), updated),
  });
  const remove = useMutation({
    mutationFn: () => client.deleteFile(id),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: fileKey(id) });
      void qc.invalidateQueries({ queryKey: ['files'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
      await navigate({ to: '/app' });
    },
  });

  if (isPending) return <p className="muted">Loading...</p>;
  if (error || !file) {
    return (
      <>
        <p role="alert" className="error">
          {describeError(error)}
        </p>
        <Link to="/app">Back to files</Link>
      </>
    );
  }

  const preview = file.variants.find((v) => v.size === 512) ?? file.variants.at(-1);
  const previewSize =
    preview && file.width && file.height ? fitInside(file.width, file.height, preview.size) : null;
  const publicUrl = `${window.location.origin}/f/${file.id}`;
  const actionError = toggle.error ?? remove.error;

  return (
    <article className="detail">
      <p>
        <Link to="/app">Back to files</Link>
      </p>
      <h1>File {file.id.slice(0, 8)}</h1>
      <p>
        <span className={`badge ${file.status}`} data-testid="status">
          {statusLabel(file.status)}
        </span>{' '}
        <span className="muted">
          {live === 'sse' && 'Live updates'}
          {live === 'polling' && 'Checking every 2 seconds'}
        </span>
      </p>
      {file.status === 'failed' && file.lastError && (
        <p role="alert" className="error">
          Processing failed: {file.lastError}
        </p>
      )}
      {preview && file.status === 'ready' && (
        <img
          className="preview"
          src={preview.url}
          width={previewSize?.width}
          height={previewSize?.height}
          alt={`Preview of file ${file.id.slice(0, 8)}`}
        />
      )}
      <dl className="facts">
        <dt>Type</dt>
        <dd>{file.contentType}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(file.bytes)}</dd>
        <dt>Dimensions</dt>
        <dd>{file.width && file.height ? `${file.width} x ${file.height}` : '-'}</dd>
        <dt>Uploaded</dt>
        <dd>{new Date(file.createdAt).toLocaleString()}</dd>
        <dt>Expires</dt>
        <dd>{new Date(file.expiresAt).toLocaleString()}</dd>
        <dt>Attempts</dt>
        <dd>{file.attempts}</dd>
      </dl>
      {file.variants.length > 0 && (
        <p>
          Variants:{' '}
          {file.variants.map((v) => (
            <a key={v.size} href={v.url} target="_blank" rel="noreferrer" className="variant">
              {v.size}px ({formatBytes(v.bytes)})
            </a>
          ))}
        </p>
      )}

      <section aria-label="Sharing">
        <label className="check">
          <input
            type="checkbox"
            checked={file.isPublic}
            disabled={toggle.isPending || file.status !== 'ready'}
            onChange={(e) => toggle.mutate(e.currentTarget.checked)}
          />
          Public
        </label>
        {file.status !== 'ready' && <span className="muted"> Available when the file is ready.</span>}
        {file.isPublic && (
          <p>
            Public link: <a href={`/f/${file.id}`}>{publicUrl}</a>
          </p>
        )}
      </section>

      {actionError && (
        <p role="alert" className="error">
          {describeError(actionError)}
        </p>
      )}
      <p>
        {confirming ? (
          <>
            <button
              type="button"
              className="danger"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Confirm delete
            </button>{' '}
            <button type="button" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </p>
    </article>
  );
}
