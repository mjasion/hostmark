// The one GitHub call the pipeline makes itself: create or update the preview comment. Only a comment written by
// github-actions[bot] and carrying the marker is ever updated, so a user cannot make the job edit their own text.
import { COMMENT_MARKER } from './comment.mjs';

export class GitHubError extends Error {}

const BOT = 'github-actions[bot]';
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * @param {{ token: string, repo: string, pr: number, body: string, fetch?: typeof fetch, apiUrl?: string }} input
 * @returns {Promise<{ action: 'created' | 'updated', id: number }>}
 */
export async function upsertComment({
  token,
  repo,
  pr,
  body,
  fetch: fetchImpl = globalThis.fetch,
  apiUrl = 'https://api.github.com',
}) {
  if (!token) throw new GitHubError('GITHUB_TOKEN is empty');
  if (!REPO.test(repo ?? '')) throw new GitHubError('repository must look like owner/name');
  if (!Number.isInteger(pr) || pr < 1)
    throw new GitHubError('pull request number must be a positive integer');
  if (!body.includes(COMMENT_MARKER)) throw new GitHubError('comment body lacks the marker');

  async function call(method, path, payload) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}/repos/${repo}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new GitHubError(`${method} ${path} failed before a response: ${error.message}`);
    }
    if (!response.ok) throw new GitHubError(`${method} ${path} answered ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new GitHubError(`${method} ${path} answered without JSON`);
    }
  }

  // Newest comments last; the preview comment is near the start, but a long thread can push it past page one.
  for (let page = 1; page <= 5; page++) {
    const comments = await call('GET', `/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments))
      throw new GitHubError('list comments answered with something that is not an array');
    const mine = comments.find(
      (c) => c?.user?.login === BOT && typeof c.body === 'string' && c.body.includes(COMMENT_MARKER),
    );
    if (mine) {
      if (!Number.isInteger(mine.id)) throw new GitHubError('existing comment has no id');
      await call('PATCH', `/issues/comments/${mine.id}`, { body });
      return { action: 'updated', id: mine.id };
    }
    if (comments.length < 100) break;
  }
  const created = await call('POST', `/issues/${pr}/comments`, { body });
  if (!Number.isInteger(created?.id)) throw new GitHubError('create comment answered without an id');
  return { action: 'created', id: created.id };
}
