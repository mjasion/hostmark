// The values committed in the wrangler configs that only stand in for the owner's own (D255). `pnpm check` accepts
// them, because the offline checks and the tests run on these files; `pnpm check --deploy`, the production pipeline
// and `pnpm run bootstrap` refuse them, because a Worker deployed with them would presign for an account that does
// not exist, point Hyperdrive at nothing and trust an origin nobody owns.

/** Any value that names a placeholder: `REPLACE_WITH_...`, or a host under the reserved example domains (RFC 2606). */
const PLACEHOLDER_TEXT = /REPLACE_WITH|(?:^|[/.@])example\.(?:com|net|org)(?:[:/]|$)/i;
/** The Hyperdrive id the configs carry until `wrangler hyperdrive create` printed a real one. */
export const PLACEHOLDER_HYPERDRIVE_ID = '00000000000000000000000000000000';

/**
 * Every placeholder in one parsed wrangler config, as messages naming the key. `skip` leaves out kinds the caller
 * fills in itself (the bootstrap creates Hyperdrive and writes its id).
 */
export function placeholderProblems(name, config, { skip = [] } = {}) {
  const problems = [];
  for (const [key, value] of Object.entries(config?.vars ?? {}))
    if (typeof value === 'string' && PLACEHOLDER_TEXT.test(value))
      problems.push(`${name}: vars.${key} is the placeholder ${JSON.stringify(value)}`);
  if (typeof config?.account_id === 'string' && PLACEHOLDER_TEXT.test(config.account_id))
    problems.push(`${name}: account_id is a placeholder`);
  if (!skip.includes('hyperdrive'))
    for (const h of config?.hyperdrive ?? [])
      if (/^0+$/.test(String(h?.id ?? '')))
        problems.push(`${name}: hyperdrive ${h.binding} still has the all-zero placeholder id`);
  return problems;
}
