import {
  ALLOWED_CONTENT_TYPES,
  type AllowedContentType,
  MAX_UPLOAD_BYTES,
} from '@hostmark/contract/constants';
import { client, describeError } from './api';
import { isUnauthorized } from './session';

export class UploadError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
    /** The API answered 401: the session ended. */
    readonly unauthorized = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Same limits as the server (D10). The server stays the authority; this only fails early. */
export function validateFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'Only JPEG, PNG and WebP images are accepted.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return `The file is larger than ${MAX_UPLOAD_BYTES / 1_048_576} MiB.`;
  return null;
}

/** `fetch` has no upload progress, so the direct PUT to the presigned URL uses XMLHttpRequest. */
function put(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);

    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(
        new UploadError(
          xhr.status === 403
            ? 'The upload link expired or was rejected by storage. Try the upload again.'
            : `Storage rejected the upload (HTTP ${xhr.status}).`,
        ),
      );
    };
    xhr.onerror = () => {
      done();
      reject(new UploadError('Network error while sending the file to storage.'));
    };
    xhr.onabort = () => {
      done();
      reject(new UploadError('Upload cancelled.', true));
    };
    xhr.send(file);
  });
}

export interface UploadHooks {
  onProgress: (fraction: number) => void;
  /** Called once the file id is known, so the UI can link to it while the PUT is running. */
  onCreated?: (fileId: string) => void;
  signal: AbortSignal;
}

/** Create, PUT, complete (D10). Resolves with the file id; throws `UploadError` with a readable message. */
export async function uploadFile(file: File, hooks: UploadHooks): Promise<string> {
  const invalid = validateFile(file);
  if (invalid) throw new UploadError(invalid);
  const { signal } = hooks;
  if (signal.aborted) throw new UploadError('Upload cancelled.', true);

  let created: Awaited<ReturnType<typeof client.createUpload>>;
  try {
    created = await client.createUpload({ contentType: file.type as AllowedContentType, bytes: file.size });
  } catch (e) {
    throw new UploadError(describeError(e), false, isUnauthorized(e));
  }
  hooks.onCreated?.(created.fileId);

  if (Date.parse(created.expiresAt) <= Date.now()) {
    throw new UploadError('The upload link has already expired. Try the upload again.');
  }
  if (signal.aborted) throw new UploadError('Upload cancelled.', true);
  await put(created.uploadUrl, created.uploadHeaders, file, hooks.onProgress, signal);

  try {
    await client.completeUpload(created.fileId);
  } catch (e) {
    throw new UploadError(describeError(e), false, isUnauthorized(e));
  }
  return created.fileId;
}
