// Inside the Playwright container, 127.0.0.1 is the container. The app and the presigned URLs name the host's
// 127.0.0.1:58080 and :59000, so forward both ports to host.docker.internal instead of changing those URLs.
import { connect, createServer } from 'node:net';

const target = process.env.E2E_FORWARD_HOST ?? 'host.docker.internal';
for (const port of (process.env.E2E_FORWARD_PORTS ?? '58080,59000').split(',').map(Number)) {
  createServer((client) => {
    const upstream = connect(port, target);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
  }).listen(port, '127.0.0.1');
}
