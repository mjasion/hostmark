// Text of the preview comment on a pull request. Every value is validated against a strict shape before it enters the
// Markdown, so nothing a pull request controls (title, branch name, commit message) can inject links or mentions.
export const COMMENT_MARKER = '<!-- hostmark-preview -->';

const SHA = /^[0-9a-f]{7,40}$/;
const HTTPS_HOST_URL = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/;
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/;

const STATUS_LINE = {
  deployed: 'Preview deployed.',
  failed: 'Preview deployment failed. The previous preview, if any, is still served.',
  'cleanup-failed':
    'Pull request closed, but removing the preview failed: some resources may be left. See the run, then re-run it.',
  closed: 'Pull request closed: preview Worker, queues and database branch were removed.',
};

/**
 * @param {{ status: 'deployed' | 'failed' | 'closed' | 'cleanup-failed', sha?: string, url?: string, runUrl?: string, databaseBranch?: string }} input
 */
export function renderComment({ status, sha, url, runUrl, databaseBranch }) {
  const line = STATUS_LINE[status];
  if (!line) throw new Error(`unknown preview status ${JSON.stringify(status)}`);
  const rows = [];
  if (status === 'deployed' && url !== undefined && HTTPS_HOST_URL.test(url))
    rows.push(['Preview', `<${url}>`]);
  if (typeof sha === 'string' && SHA.test(sha)) rows.push(['Commit', `\`${sha.slice(0, 12)}\``]);
  if (
    status === 'deployed' &&
    typeof databaseBranch === 'string' &&
    /^preview\/pr-\d+$/.test(databaseBranch)
  ) {
    rows.push([
      'Database',
      `Neon branch \`${databaseBranch}\` (copy of the preview parent, deleted on close)`,
    ]);
  }
  if (typeof runUrl === 'string' && RUN_URL.test(runUrl)) rows.push(['Run', `<${runUrl}>`]);

  const table =
    rows.length === 0 ? '' : `\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}`;
  return `${COMMENT_MARKER}\n**hostmark preview (Cloudflare)**\n\n${line}${table}\n`;
}
