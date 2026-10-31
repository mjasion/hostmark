import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  InvalidImageError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../src/errors';
import * as ports from '../src/ports';

describe('errors', () => {
  it.each([
    [ValidationError, 400],
    [UnauthorizedError, 401],
    [ForbiddenError, 403],
    [NotFoundError, 404],
    [ConflictError, 409],
    [PayloadTooLargeError, 413],
    [InvalidImageError, 422],
    [ServiceUnavailableError, 503],
  ])('%o maps to %i', (Ctor, status) => {
    const e = new Ctor();
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(status);
    expect(e.name).toBe(Ctor.name);
  });

  it('exposes detail only when it adds information', () => {
    expect(new NotFoundError().detail).toBeUndefined();
    expect(new NotFoundError('no such file').detail).toBe('no such file');
  });

  it('keeps the cause', () => {
    const cause = new Error('boom');
    expect(new InvalidImageError('bad', { cause }).cause).toBe(cause);
  });
});

describe('ports entry', () => {
  it('re-exports InvalidImageError and nothing else at runtime', () => {
    expect(Object.keys(ports)).toEqual(['InvalidImageError']);
  });
});
