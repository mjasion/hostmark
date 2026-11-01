import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// jsdom does not implement scrolling; the router calls it on navigation.
window.scrollTo = () => {};
