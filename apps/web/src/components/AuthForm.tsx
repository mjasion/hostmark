import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { endSession } from '../api';
import { signIn, signUp } from '../auth';
import { clearUserData, sessionKey } from '../session';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      await (signup ? signUp(email, password) : signIn(email, password));
      // The session may have ended without a 401, so the previous user's files can still be cached, and a request
      // of that session can still be running.
      endSession();
      clearUserData(qc);
      await qc.invalidateQueries({ queryKey: sessionKey });
      await navigate({ to: '/app' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <a className="brand" href="/">
        hostmark
      </a>
      <h1>{signup ? 'Create your account' : 'Log in'}</h1>
      <form onSubmit={submit} className="stack">
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Please wait...' : signup ? 'Sign up' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        {signup ? (
          <>
            Already have an account? <Link to="/login">Log in</Link>
          </>
        ) : (
          <>
            New here? <Link to="/signup">Create an account</Link>
          </>
        )}
      </p>
    </main>
  );
}
