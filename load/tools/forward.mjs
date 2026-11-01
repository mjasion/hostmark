// TCP forwarder for the sidecar container (see run.mjs). On Docker Desktop the host's loopback is not reachable from a
// container, and presigned upload URLs are signed for the host 127.0.0.1:59000, so they cannot be rewritten. This
// listens on the same loopback ports inside a container whose network k6 or Playwright shares, and forwards each one
// to the host: the URL stays byte-identical and the signature stays valid.
import { connect, createServer } from 'node:net';

const target = process.env.FORWARD_HOST ?? 'host.docker.internal';
const ports = (process.env.FORWARD_PORTS ?? '58080,59000')
  .split(',')
  .map(Number)
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

// A port named in FORWARD_ROUTES (58080=api:8080) goes straight to a compose service, the rest to the host.
const routes = new Map(
  (process.env.FORWARD_ROUTES ?? '')
    .split(',')
    .filter(Boolean)
    .map((r) => r.split('=')),
);

for (const port of ports) {
  const [host, hostPort] = (routes.get(String(port)) ?? `${target}:${port}`).split(':');
  createServer((client) => {
    const upstream = connect(Number(hostPort), host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
  }).listen(port, '127.0.0.1');
}
console.log(`forwarding 127.0.0.1:${ports.join(',')} to ${target}`);
