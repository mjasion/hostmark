import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppQueryClient, createAppRouter } from '../src/router';
import {
  createFile,
  FakeEventSource,
  FakeXHR,
  FILE_ID,
  fileJson,
  type Handler,
  json,
  problem,
  stubFetch,
} from './fakes';

const session = { user: { id: 'u1', email: 'me@example.com', name: 'me' } };
const stats = {
  items: [
    {
      day: '2026-01-01',
      platform: 'local',
      uploads: 3,
      ready: 2,
      failed: 1,
      bytesIn: 2_097_152,
      p50ProcessingMs: 1,
      p95ProcessingMs: 2,
    },
  ],
};

function mount(path: string, routes: Record<string, Handler>) {
  const fetchStub = stubFetch(routes);
  const queryClient = createAppQueryClient(() => void router.navigate({ to: '/login' }));
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...fetchStub };
}

const panelRoutes = (files: unknown[] = []): Record<string, Handler> => ({
  'GET /api/auth/get-session': () => json(session),
  'GET /api/stats': () => json(stats),
  'GET /api/files': () => json({ items: files, nextCursor: null }),
});

const uploadRoutes = (): Record<string, Handler> => ({
  ...panelRoutes(),
  'POST /api/uploads': () =>
    json(
      {
        fileId: FILE_ID,
        uploadUrl: 'http://storage.test/put',
        uploadHeaders: { 'content-type': 'image/png' },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      201,
    ),
  [`POST /api/uploads/${FILE_ID}/complete`]: () => json(fileJson({ status: 'queued' })),
});

const pick = async (...files: File[]) => {
  const input = (await screen.findByLabelText('Choose files')) as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
};

beforeEach(() => {
  FakeXHR.reset();
  FakeEventSource.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('routing', () => {
  it('redirects a signed-out visit of /app/* to /login', async () => {
    const { router } = mount(`/app/files/${FILE_ID}`, { 'GET /api/auth/get-session': () => json(null) });
    await screen.findByRole('heading', { name: 'Log in' });
    expect(router.state.location.pathname).toBe('/login');
  });

  it('sends a signed-in visitor of /login to /app', async () => {
    const { router } = mount('/login', panelRoutes());
    await screen.findByText('No files yet. Upload an image to get started.');
    expect(router.state.location.pathname).toBe('/app');
  });
});

describe('auth forms', () => {
  it('logs in and lands on /app', async () => {
    let signedIn = false;
    const { router, calls } = mount('/login', {
      ...panelRoutes(),
      'GET /api/auth/get-session': () => json(signedIn ? session : null),
      'POST /api/auth/sign-in/email': () => {
        signedIn = true;
        return json({ token: 't', user: session.user });
      },
    });
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app'));
    const post = calls.find((c) => c.path === '/api/auth/sign-in/email');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      email: 'me@example.com',
      password: 'correct horse',
    });
  });

  it('says so when signup is disabled', async () => {
    mount('/signup', {
      'GET /api/auth/get-session': () => json(null),
      'POST /api/auth/sign-up/email': () =>
        json(
          { code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED', message: 'Email and password sign up is not enabled' },
          400,
        ),
    });
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Signup is disabled on this deployment.');
  });

  it('shows a wrong password message', async () => {
    mount('/login', {
      'GET /api/auth/get-session': () => json(null),
      'POST /api/auth/sign-in/email': () => json({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' }, 401),
    });
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong email or password.');
  });
});

describe('panel', () => {
  it('shows usage from /api/stats', async () => {
    mount('/app', panelRoutes());
    await screen.findByText('2.0 MiB');
    expect(screen.getByLabelText('Platform usage').textContent).toContain('3');
  });

  it('uploads a picked file with progress and links to it', async () => {
    mount('/app', uploadRoutes());
    await pick(createFile());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.last().progress(617, 1234));
    const bar = (await screen.findByLabelText('Upload progress of a.png')) as HTMLProgressElement;
    await waitFor(() => expect(bar.value).toBe(50));
    act(() => FakeXHR.last().finish(200));
    await screen.findByText('Uploaded, processing.');
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(`/app/files/${FILE_ID}`);
  });

  it('reports a failed PUT and offers a retry', async () => {
    mount('/app', uploadRoutes());
    await pick(createFile());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.last().finish(403));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or was rejected/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
  });

  it('cancels an upload in progress', async () => {
    mount('/app', uploadRoutes());
    await pick(createFile());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('Cancelled.');
    expect(FakeXHR.last().aborted).toBe(true);
  });

  it('rejects a wrong type before any request', async () => {
    const { calls } = mount('/app', panelRoutes());
    await pick(createFile('a.gif', 'image/gif'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/JPEG, PNG and WebP/);
    expect(calls.some((c) => c.path === '/api/uploads')).toBe(false);
  });

  it('uploads dropped files', async () => {
    mount('/app', uploadRoutes());
    const zone = await screen.findByLabelText('Upload');
    fireEvent.drop(zone, { dataTransfer: { files: [createFile()] } });
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
  });

  it('polls the gallery while a file is unfinished and opens no event stream', async () => {
    const processing = fileJson({ status: 'processing' });
    const { calls } = mount('/app', panelRoutes([processing]));
    await screen.findByText('Processing', { selector: '.caption' });
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/files').length).toBeGreaterThan(1), {
      timeout: 4000,
    });
    expect(FakeEventSource.instances).toHaveLength(0);
  }, 10_000);

  it('marks a file with the same content as a duplicate', async () => {
    const thumb = (id: string) => ({ size: 128, url: `http://s.test/${id}`, bytes: 1 });
    const a = fileJson({
      id: '0198c8a6-2b1e-7c3a-9d2f-000000000002',
      status: 'ready',
      sha256: 'h',
      variants: [thumb('a')],
    });
    const b = fileJson({
      id: '0198c8a6-2b1e-7c3a-9d2f-000000000001',
      status: 'ready',
      sha256: 'h',
      variants: [thumb('b')],
    });
    mount('/app', panelRoutes([a, b]));
    await screen.findByText(/\(duplicate\)/);
    expect(screen.getAllByText(/\(duplicate\)/)).toHaveLength(1);
  });
});

describe('file page', () => {
  it('toggles public, shows the link, and deletes', async () => {
    let isPublic = false;
    const { router } = mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      [`GET /api/files/${FILE_ID}`]: () =>
        json(
          fileJson({
            status: 'ready',
            isPublic,
            variants: [{ size: 512, url: 'http://s.test/p', bytes: 1 }],
          }),
        ),
      [`PATCH /api/files/${FILE_ID}`]: (_u, init) => {
        isPublic = JSON.parse(String(init.body)).isPublic;
        return json(fileJson({ status: 'ready', isPublic }));
      },
      [`DELETE /api/files/${FILE_ID}`]: () => new Response(null, { status: 204 }),
    });
    const box = (await screen.findByLabelText('Public')) as HTMLInputElement;
    fireEvent.click(box);
    const link = await screen.findByRole('link', { name: /\/f\// });
    expect(link.getAttribute('href')).toBe(`/f/${FILE_ID}`);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app'));
  });

  it('closes its event stream when navigating away', async () => {
    const { router } = mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      [`GET /api/files/${FILE_ID}`]: () => json(fileJson({ status: 'processing' })),
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0]?.open();
    await act(async () => {
      await router.navigate({ to: '/app' });
    });
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(0));
  });
});

describe('fix round', () => {
  const problem401 = () =>
    new Response(
      JSON.stringify({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Missing credentials',
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      },
    );

  it('drops user A everything on a 401 and shows B nothing of A', async () => {
    const A = fileJson({ id: '0198c8a6-2b1e-7c3a-9d2f-aaaaaaaaaaaa', status: 'ready' });
    let user: 'a' | 'b' | null = 'a';
    let expired = false;
    const { router } = mount('/app', {
      'GET /api/auth/get-session': () =>
        json(user ? { user: { id: user, email: `${user}@x.test`, name: user } } : null),
      'GET /api/stats': () => json(stats),
      'GET /api/files': () =>
        expired ? problem401() : json({ items: user === 'a' ? [A] : [], nextCursor: null }),
      'POST /api/auth/sign-in/email': () => {
        user = 'b';
        return json({ token: 't' });
      },
    });
    await screen.findByText(/Ready|KiB/, { selector: '.caption' });
    expired = true;
    user = null;
    await act(async () => {
      await router.invalidate();
      await router.navigate({ to: '/app' });
    });
    await act(async () => {
      // any refetch of the list answers 401
      const { queryClient } = router.options.context;
      await queryClient.refetchQueries({ queryKey: ['files'] });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    const { queryClient } = router.options.context;
    expect(queryClient.getQueryData(['files'])).toBeUndefined();
    expect(queryClient.getQueryData(['session'])).toBeNull();
    expired = false;
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'b@x.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await screen.findByText('No files yet. Upload an image to get started.');
    expect(document.body.innerHTML).not.toContain('aaaaaaaaaaaa');
  });

  it.each([['PATCH'], ['DELETE']])('redirects to /login on a 401 from %s', async (method) => {
    const { router } = mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      [`GET /api/files/${FILE_ID}`]: () => json(fileJson({ status: 'ready' })),
      [`${method} /api/files/${FILE_ID}`]: problem401,
    });
    if (method === 'PATCH') fireEvent.click(await screen.findByLabelText('Public'));
    else {
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    }
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByText('Missing credentials')).toBeNull();
  });

  it('keeps pending_upload rows out of the gallery and does not poll for them', async () => {
    const pending = fileJson({ id: '0198c8a6-2b1e-7c3a-9d2f-000000000009', status: 'pending_upload' });
    const { calls } = mount('/app', panelRoutes([pending]));
    await screen.findByText('No files yet. Upload an image to get started.');
    await new Promise((r) => setTimeout(r, 2500));
    expect(calls.filter((c) => c.path === '/api/files')).toHaveLength(1);
  }, 10_000);

  it('still offers Load more when a page holds only pending rows', async () => {
    const pending = fileJson({ status: 'pending_upload' });
    mount('/app', {
      ...panelRoutes(),
      'GET /api/files': () => json({ items: [pending], nextCursor: 'c1' }),
    });
    await screen.findByRole('button', { name: 'Load more' });
    expect(screen.queryByText('Uploading')).toBeNull();
  });

  it('reserves the preview size from the API dimensions', async () => {
    mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      [`GET /api/files/${FILE_ID}`]: () =>
        json(
          fileJson({
            status: 'ready',
            width: 3000,
            height: 1500,
            variants: [{ size: 512, url: 'http://s.test/p', bytes: 1 }],
          }),
        ),
    });
    const img = (await screen.findByAltText(/Preview of file/)) as HTMLImageElement;
    expect(img.getAttribute('width')).toBe('512');
    expect(img.getAttribute('height')).toBe('256');
  });

  it('shows a failed sign-out and re-enables the button', async () => {
    mount('/app', {
      ...panelRoutes(),
      'POST /api/auth/sign-out': () => json({ message: 'boom' }, 500),
    });
    const button = (await screen.findByRole('button', { name: 'Sign out' })) as HTMLButtonElement;
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not sign out: boom');
    expect(button.disabled).toBe(false);
  });

  it('stops polling a file that answers 404', async () => {
    let n = 0;
    FakeEventSource.reset();
    mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      [`GET /api/files/${FILE_ID}`]: () => {
        n++;
        return n === 1
          ? json(fileJson({ status: 'processing' }))
          : new Response(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }), {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            });
      },
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]?.fail(true));
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    const at = n;
    await new Promise((r) => setTimeout(r, 4500));
    expect(n).toBe(at);
  }, 15_000);

  it('sends a traceparent on auth calls', async () => {
    const { calls } = mount('/login', { 'GET /api/auth/get-session': () => json(null) });
    await screen.findByRole('heading', { name: 'Log in' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe('final fix round', () => {
  const sessionOf = (router: ReturnType<typeof mount>['router']) =>
    router.options.context.queryClient.getQueryData(['session']);

  it('shows B nothing of A when the session ended without a 401', async () => {
    const A = fileJson({ id: '0198c8a6-2b1e-7c3a-9d2f-aaaaaaaaaaaa', status: 'ready' });
    let user: 'a' | 'b' | null = 'a';
    let release: () => void = () => {};
    let hold = false;
    const { router, calls } = mount('/app', {
      'GET /api/auth/get-session': () =>
        json(user ? { user: { id: user, email: `${user}@x.test`, name: user } } : null),
      'GET /api/stats': () => json(stats),
      'GET /api/files': async () => {
        if (hold) await new Promise<void>((r) => (release = r));
        return json({ items: user === 'a' ? [A] : [], nextCursor: null });
      },
      'POST /api/auth/sign-in/email': () => {
        user = 'b';
        return json({ token: 't' });
      },
    });
    await screen.findByText(/Ready|KiB/, { selector: '.caption' });
    // The session ended without any 401: the guard just gets null from get-session.
    user = null;
    const { queryClient } = router.options.context;
    queryClient
      .getQueryCache()
      .find({ queryKey: ['session'] })
      ?.setState({ dataUpdatedAt: Date.now() - 60_000 });
    await act(async () => {
      await router.invalidate();
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.filter((c) => c.path === '/api/auth/get-session').length).toBeGreaterThan(1);

    hold = true;
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'b@x.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app'));
    // B's list has not answered yet: whatever is on screen now must not come from A's cache.
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/files')).toHaveLength(2));
    expect(document.body.innerHTML).not.toContain('aaaaaaaaaaaa');
    expect(screen.queryByText(/Ready/, { selector: '.caption' })).toBeNull();
    release();
    await screen.findByText('No files yet. Upload an image to get started.');
  });

  describe('a 401 while uploading', () => {
    const expectSignedOut = async (router: ReturnType<typeof mount>['router']) => {
      await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
      expect(sessionOf(router)).toBeNull();
      expect(router.options.context.queryClient.getQueryData(['files'])).toBeUndefined();
      expect(screen.queryByRole('alert')).toBeNull();
    };

    it('on POST /api/uploads signs the user out', async () => {
      const { router } = mount('/app', {
        ...uploadRoutes(),
        'POST /api/uploads': () => problem(401, 'Unauthorized', 'Missing credentials'),
      });
      await screen.findByText('No files yet. Upload an image to get started.');
      await pick(createFile());
      await expectSignedOut(router);
      expect(FakeXHR.instances).toHaveLength(0);
    });

    it('on POST /api/uploads/:id/complete signs the user out', async () => {
      const { router } = mount('/app', {
        ...uploadRoutes(),
        [`POST /api/uploads/${FILE_ID}/complete`]: () => problem(401, 'Unauthorized', 'Missing credentials'),
      });
      await screen.findByText('No files yet. Upload an image to get started.');
      await pick(createFile());
      await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
      act(() => FakeXHR.last().finish(200));
      await expectSignedOut(router);
    });

    it('is the only upload error that signs the user out; others keep the row and Retry', async () => {
      const { router } = mount('/app', {
        ...uploadRoutes(),
        'POST /api/uploads': () => problem(500, 'Internal Server Error', 'Database is down'),
      });
      await pick(createFile());
      expect((await screen.findByRole('alert')).textContent).toBe('Database is down');
      screen.getByRole('button', { name: 'Retry' });
      expect(router.state.location.pathname).toBe('/app');
      expect(sessionOf(router)).not.toBeNull();
    });

    it('keeps the session, the row and Retry when the PUT to storage fails', async () => {
      const { router } = mount('/app', uploadRoutes());
      await pick(createFile());
      await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
      act(() => FakeXHR.last().finish(500));
      expect((await screen.findByRole('alert')).textContent).toBe('Storage rejected the upload (HTTP 500).');
      screen.getByRole('button', { name: 'Retry' });
      expect(router.state.location.pathname).toBe('/app');
      expect(sessionOf(router)).not.toBeNull();
    });

    it('keeps the session, the row and Retry when complete fails', async () => {
      const { router } = mount('/app', {
        ...uploadRoutes(),
        [`POST /api/uploads/${FILE_ID}/complete`]: () =>
          problem(503, 'Service Unavailable', 'Could not enqueue the job'),
      });
      await pick(createFile());
      await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
      act(() => FakeXHR.last().finish(200));
      expect((await screen.findByRole('alert')).textContent).toBe('Could not enqueue the job');
      screen.getByRole('button', { name: 'Retry' });
      expect(router.state.location.pathname).toBe('/app');
      expect(sessionOf(router)).not.toBeNull();
    });
  });

  it.each([[500], [503]])('keeps the user signed in when a query answers %i', async (status) => {
    const { router } = mount('/app', {
      ...panelRoutes(),
      'GET /api/files': () => problem(status, 'Server error', 'Try later'),
    });
    expect((await screen.findByText('Try later', { selector: '[role="alert"]' })).textContent).toBe(
      'Try later',
    );
    expect(router.state.location.pathname).toBe('/app');
    expect(sessionOf(router)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  describe('preview size', () => {
    const preview = (width: number, height: number, size: number) => async () => {
      mount(`/app/files/${FILE_ID}`, {
        ...panelRoutes(),
        [`GET /api/files/${FILE_ID}`]: () =>
          json(
            fileJson({
              status: 'ready',
              width,
              height,
              variants: [{ size, url: 'http://s.test/p', bytes: 1 }],
            }),
          ),
      });
      return (await screen.findByAltText(/Preview of file/)) as HTMLImageElement;
    };

    it('scales a portrait image so the longer side, the height, is the variant size', async () => {
      const img = await preview(1500, 3000, 512)();
      expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['256', '512']);
    });

    it('does not enlarge an image smaller than the variant size', async () => {
      const img = await preview(300, 200, 512)();
      expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['300', '200']);
    });
  });
});

describe('E1 gaps (D302, D304)', () => {
  const sessionOf = (router: ReturnType<typeof mount>['router']) =>
    router.options.context.queryClient.getQueryData(['session']);
  const completePath = `/api/uploads/${FILE_ID}/complete`;

  describe('file not found', () => {
    it.each(['not-a-uuid', '..%2f..%2fetc', '..%2F..%2Fetc%2Fpasswd', `${FILE_ID}x`])(
      'shows it for /app/files/%s without asking the API',
      async (id) => {
        const { calls } = mount(`/app/files/${id}`, panelRoutes());
        await screen.findByRole('heading', { name: 'File not found' });
        expect(screen.getByRole('link', { name: 'Back to files' }).getAttribute('href')).toBe('/app');
        expect(calls.filter((c) => c.path.startsWith('/api/files/'))).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(0);
      },
    );

    it.each([
      [404, 'Not Found', 'File not found'],
      [400, 'Bad Request', 'Request validation failed'],
    ])('shows it when the API answers %i', async (status, title, detail) => {
      mount(`/app/files/${FILE_ID}`, {
        ...panelRoutes(),
        [`GET /api/files/${FILE_ID}`]: () => problem(status, title, detail),
      });
      await screen.findByRole('heading', { name: 'File not found' });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('still shows other errors as they are', async () => {
      mount(`/app/files/${FILE_ID}`, {
        ...panelRoutes(),
        [`GET /api/files/${FILE_ID}`]: () => problem(500, 'Internal Server Error', 'Try again later'),
      });
      expect((await screen.findByRole('alert')).textContent).toBe('Try again later');
      expect(screen.queryByRole('heading', { name: 'File not found' })).toBeNull();
    });
  });

  describe('Retry', () => {
    it('is not offered for a file refused before any request', async () => {
      mount('/app', panelRoutes());
      await pick(createFile('a.gif', 'image/gif'));
      await screen.findByRole('alert');
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      screen.getByRole('button', { name: 'Dismiss' });
    });

    it.each([
      [413, 'Declared size exceeds 10485760 bytes'],
      [400, 'Request validation failed'],
    ])('is not offered when the API refuses the file with %i', async (status, detail) => {
      mount('/app', { ...uploadRoutes(), 'POST /api/uploads': () => problem(status, 'Refused', detail) });
      await pick(createFile());
      expect((await screen.findByRole('alert')).textContent).toBe(detail);
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('is not offered when complete finds the stored object too large', async () => {
      mount('/app', {
        ...uploadRoutes(),
        [`POST ${completePath}`]: () =>
          problem(413, 'Payload Too Large', 'Uploaded object exceeds 10485760 bytes'),
      });
      await pick(createFile());
      await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
      act(() => FakeXHR.last().finish(200));
      await screen.findByText('Uploaded object exceeds 10485760 bytes');
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
  });

  it('cancels a running complete: the request is aborted and the list is checked again', async () => {
    const { calls } = mount('/app', {
      ...uploadRoutes(),
      [`POST ${completePath}`]: () => new Promise<Response>(() => {}),
    });
    await screen.findByText('No files yet. Upload an image to get started.');
    await pick(createFile());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.last().finish(200));
    await waitFor(() => expect(calls.some((c) => c.path === completePath)).toBe(true));
    const lists = calls.filter((c) => c.path === '/api/files').length;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByText(/^Cancelled\. If the server had already accepted the file/);
    expect(calls.find((c) => c.path === completePath)?.init.signal?.aborted).toBe(true);
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/files').length).toBeGreaterThan(lists));
    screen.getByRole('button', { name: 'Retry' });
  });

  it('closes the event stream at sign-out, before the page unmounts', async () => {
    let signedIn = true;
    mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      // After sign-out the session check of /login never answers, so the file page stays mounted.
      'GET /api/auth/get-session': () => (signedIn ? json(session) : new Promise<Response>(() => {})),
      'POST /api/auth/sign-out': () => {
        signedIn = false;
        return json({ success: true });
      },
      [`GET /api/files/${FILE_ID}`]: () => json(fileJson({ status: 'processing' })),
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]?.open());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(0));
    // Still on the file page: the sign-out closed the stream, not an unmount.
    expect(screen.getByTestId('status').textContent).toBe('Processing');
  });

  it('a complete left running by a signed-out user cannot sign out the next one', async () => {
    let user: 'a' | 'b' | null = 'a';
    let answer: (res: Response) => void = () => {};
    const { router, calls } = mount('/app', {
      ...uploadRoutes(),
      'GET /api/auth/get-session': () =>
        json(user ? { user: { id: user, email: `${user}@x.test`, name: user } } : null),
      'POST /api/auth/sign-out': () => {
        user = null;
        return json({ success: true });
      },
      'POST /api/auth/sign-in/email': () => {
        user = 'b';
        return json({ token: 't' });
      },
      [`POST ${completePath}`]: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    await screen.findByText('No files yet. Upload an image to get started.');
    await pick(createFile());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.last().finish(200));
    await waitFor(() => expect(calls.some((c) => c.path === completePath)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.find((c) => c.path === completePath)?.init.signal?.aborted).toBe(true);

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'b@x.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await screen.findByText('No files yet. Upload an image to get started.');

    // The server finally answers A's complete, with a 401.
    answer(problem(401, 'Unauthorized', 'Missing credentials'));
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe('/app');
    expect(sessionOf(router)).toMatchObject({ user: { id: 'b' } });
  });

  it('loads an expired lazy thumbnail again, once, with a fresh URL', async () => {
    let lists = 0;
    mount('/app', {
      ...panelRoutes(),
      'GET /api/files': () => {
        lists++;
        const variants = [{ size: 128, url: `http://s.test/thumb-${lists}`, bytes: 1 }];
        return json({ items: [fileJson({ status: 'ready', variants })], nextCursor: null });
      },
    });
    const thumb = () => screen.getByAltText(/Thumbnail of file/);
    await screen.findByAltText(/Thumbnail of file/);
    expect(thumb().getAttribute('src')).toBe('http://s.test/thumb-1');
    fireEvent.error(thumb());
    await waitFor(() => expect(thumb().getAttribute('src')).toBe('http://s.test/thumb-2'));
    expect(lists).toBe(2);
    // The fresh URL fails too: no loop.
    fireEvent.error(thumb());
    await new Promise((r) => setTimeout(r, 100));
    expect(lists).toBe(2);
    expect(thumb().getAttribute('src')).toBe('http://s.test/thumb-2');
  });

  it('shows the file dates in English', async () => {
    mount(`/app/files/${FILE_ID}`, {
      ...panelRoutes(),
      [`GET /api/files/${FILE_ID}`]: () =>
        json(
          fileJson({
            status: 'ready',
            createdAt: '2026-01-01T12:00:00.000Z',
            expiresAt: '2026-01-08T12:00:00.000Z',
          }),
        ),
    });
    const value = (term: string) => screen.getByText(term).nextElementSibling?.textContent ?? '';
    await screen.findByText('Uploaded');
    expect(value('Uploaded')).toMatch(/^Jan 1, 2026, \d{1,2}:\d{2}\s[AP]M$/);
    expect(value('Expires')).toMatch(/^Jan 8, 2026, \d{1,2}:\d{2}\s[AP]M$/);
  });
});
