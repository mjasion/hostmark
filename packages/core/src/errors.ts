// Domain errors. Dependency free on purpose: `@hostmark/core/ports` re-exports InvalidImageError so image
// processors can throw it without pulling in the rest of core.

export class DomainError extends Error {
  constructor(
    /** HTTP status the api maps this error to. */
    readonly status: number,
    /** Stable machine readable slug. */
    readonly code: string,
    /** Short human readable summary, the RFC 9457 `title`. */
    readonly title: string,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ?? title, options);
    this.name = new.target.name;
  }

  /** RFC 9457 `detail`; undefined when the message only repeats the title. */
  get detail(): string | undefined {
    return this.message === this.title ? undefined : this.message;
  }
}

/** Zod validation errors are produced by the framework; this is for rules that schemas cannot express. */
export class ValidationError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(400, 'validation_error', 'Bad Request', detail, options);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(401, 'unauthorized', 'Unauthorized', detail, options);
  }
}

export class ForbiddenError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(403, 'forbidden', 'Forbidden', detail, options);
  }
}

/** Also used for files that belong to another user: their existence is not revealed. */
export class NotFoundError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(404, 'not_found', 'Not Found', detail, options);
  }
}

export class ConflictError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(409, 'conflict', 'Conflict', detail, options);
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(413, 'payload_too_large', 'Payload Too Large', detail, options);
  }
}

/** Permanent: the input cannot be decoded, so retrying is pointless (D17). */
export class InvalidImageError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(422, 'invalid_image', 'Unprocessable Content', detail, options);
  }
}

export class NotImplementedError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(501, 'not_implemented', 'Not Implemented', detail, options);
  }
}

export class ServiceUnavailableError extends DomainError {
  constructor(detail?: string, options?: ErrorOptions) {
    super(503, 'service_unavailable', 'Service Unavailable', detail, options);
  }
}
