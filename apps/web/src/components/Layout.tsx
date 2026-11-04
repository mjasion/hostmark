import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { endSession } from '../api';
import { getSession, signOut } from '../auth';
import { sessionKey } from '../session';
import { UploadsProvider } from '../uploads';

export function Layout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useQuery({ queryKey: sessionKey, queryFn: getSession, staleTime: 30_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function out() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
    } catch (e) {
      setError(`Could not sign out: ${e instanceof Error ? e.message : 'unknown error'}`);
      setBusy(false);
      return;
    }
    // At once, not when the page unmounts: the route change waits for the session check of /login.
    endSession();
    qc.clear();
    await navigate({ to: '/login' });
  }

  return (
    <UploadsProvider>
      <header className="bar">
        <Link to="/app" className="brand">
          hostmark
        </Link>
        <span className="grow" />
        {session && <span className="muted">{session.user.email}</span>}
        <button type="button" onClick={out} disabled={busy}>
          Sign out
        </button>
      </header>
      <main className="page">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Outlet />
      </main>
    </UploadsProvider>
  );
}
