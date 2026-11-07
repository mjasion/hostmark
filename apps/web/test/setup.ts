import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// jsdom does not implement scrolling; the router calls it on navigation.
// Guarded: a test that builds the app runs in the node environment (csp.test.ts).
if (typeof window !== 'undefined') window.scrollTo = () => {};
