import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Outlet,
  type RouterHistory,
  RouterProvider,
  redirect,
} from '@tanstack/react-router';
import { AuthForm } from './components/AuthForm';
import { FileDetail } from './components/FileDetail';
import { Layout } from './components/Layout';
import { Panel } from './components/Panel';
import { isUnauthorized, loadSession, redirectWhenSignedOut, signedOut } from './session';

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <main className="auth">
      <h1>Page not found</h1>
      <Link to="/app">Back to the panel</Link>
    </main>
  ),
});

// Signed-in visitors skip the auth forms.
const guestOnly = async ({ context }: { context: RouterContext }) => {
  if (await loadSession(context.queryClient)) throw redirect({ to: '/app' });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: guestOnly,
  component: () => <AuthForm mode="login" />,
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  beforeLoad: guestOnly,
  component: () => <AuthForm mode="signup" />,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: async ({ context }) => {
    if (!(await loadSession(context.queryClient))) throw redirect({ to: '/login' });
  },
  component: Layout,
});
const panelRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: Panel });
const fileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'files/$id',
  component: function FileRoute() {
    const { id } = fileRoute.useParams();
    return <FileDetail id={id} />;
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  appRoute.addChildren([panelRoute, fileRoute]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

/**
 * A 401 from any query or mutation means the session ended. Everything cached for that user is dropped (so the
 * next user of this tab sees nothing of it), the session becomes `null`, and `onUnauthorized` goes to `/login`.
 * Uploads report their 401 through the same `signedOut`.
 */
export function createAppQueryClient(onUnauthorized: () => void = () => {}) {
  const onError = (error: Error) => {
    if (isUnauthorized(error)) signedOut(qc);
  };
  const qc: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
  });
  redirectWhenSignedOut(qc, onUnauthorized);
  return qc;
}

export function App({
  queryClient,
  router,
}: {
  queryClient: QueryClient;
  router: ReturnType<typeof createAppRouter>;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
