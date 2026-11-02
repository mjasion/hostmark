// A fake `fetch` driven by a list of expected calls. Unexpected or leftover calls fail the test.
export function fakeFetch(routes) {
  const calls = [];
  const queue = [...routes];
  const fn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url: String(url),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers,
    });
    const index = queue.findIndex((r) => r.method === method && String(url).includes(r.match));
    if (index === -1) throw new Error(`unexpected call ${method} ${url}`);
    const [route] = queue.splice(index, 1);
    if (route.throws) throw new Error(route.throws);
    const status = route.status ?? 200;
    const text = route.raw ?? (route.json === undefined ? '' : JSON.stringify(route.json));
    return new Response(text, { status, headers: route.headers });
  };
  fn.calls = calls;
  fn.remaining = () => queue;
  return fn;
}

export const BRANCH = 'br-cool-sun-12345678';
export const PARENT = 'br-main-parent-1';
export const ENDPOINT = 'ep-cool-sun-12345678';
export const URI_DIRECT =
  'postgresql://app:s3cret-pass@ep-cool-sun-12345678.eu-central-1.aws.neon.tech/hostmark?sslmode=require';
export const URI_POOLED =
  'postgresql://app:s3cret-pass@ep-cool-sun-12345678-pooler.eu-central-1.aws.neon.tech/hostmark?sslmode=require';
export const VERSION_A = '11111111-1111-4111-8111-111111111111';
export const VERSION_B = '22222222-2222-4222-8222-222222222222';
