// A pushed delivery carries its payload in the request, and `handleCallback` of `@vercel/queue` runs the handler on it
// without asking the queue service whether the message exists (D234). Before the handler runs, this asks the service
// to extend the delivery's lease with the receipt handle of the request: only a delivery the service handed out has a
// receipt handle it accepts, so a forged POST is refused before any job code runs (D235).
import { VISIBILITY_TIMEOUT_SECONDS } from '@hostmark/contract';
import {
  BadRequestError,
  CLOUD_EVENT_TYPE_V2BETA,
  ForbiddenError,
  MessageNotAvailableError,
  MessageNotFoundError,
  QueueClient,
  UnauthorizedError,
} from '@vercel/queue';

/** The lease call of the queue service, as the SDK's API client has it. */
export interface LeaseApi {
  changeVisibility(options: {
    messageId: string;
    queueName: string;
    consumerGroup: string;
    receiptHandle: string;
    visibilityTimeoutSeconds: number;
  }): Promise<unknown>;
  withRegion?(region: string): LeaseApi;
}

/**
 * The SDK keeps its API client behind `Symbol.for('@vercel/queue.apiClient')` on a `QueueClient` (it uses the same key
 * to find it across bundled copies). `handleCallback` routes follow-up calls the same way: `withRegion` of that client.
 * A test pins both against the installed SDK, so an upgrade that moves them fails there and not on a deployment.
 */
export function leaseApiOf(client: QueueClient = new QueueClient()): LeaseApi {
  const api = (client as unknown as Record<symbol, unknown>)[Symbol.for('@vercel/queue.apiClient')] as
    | LeaseApi
    | undefined;
  if (!api || typeof api.changeVisibility !== 'function')
    throw new Error('@vercel/queue no longer exposes its API client; check D235 before upgrading');
  return api;
}

/** Errors with which the service refuses a receipt handle or the caller: the delivery is not one it handed out. */
const REFUSED = [
  MessageNotFoundError,
  MessageNotAvailableError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
];

export interface VerifyOptions {
  /** The only topic this route consumes; read per request, so a module import needs no environment. */
  topic: () => string;
  /** The API client; built lazily so a module import needs no OIDC token. */
  api: () => LeaseApi;
  /**
   * The lease set by the check: the visibility the route's `handleCallback` runs under, which the SDK renews from
   * then on. Default: D17's 60 s, the value `src/functions/queue.ts` passes to both (D275).
   */
  visibilityTimeoutSeconds?: number;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * A value the SDK puts into a URL path segment. `encodeURIComponent` keeps `.` and `..`, which `fetch` then removes as
 * dot segments, so a lease call for `consumer/../lease/..` would address another resource of the queue service
 * (D334). Anything else is encoded into a single segment by the SDK.
 */
const isPathSegment = (value: string): boolean => value !== '.' && value !== '..' && value.length <= 1024;

/**
 * Wraps a queue route. Only a binary mode v2beta delivery for this route's topic is accepted, the only kind the
 * `queue/v2beta` trigger in vercel.json sends: a structured (v1beta) callback names its topic in the body, which the
 * topic check would not see (D334). With a receipt handle (its payload in the body), it runs only after the service
 * accepted the receipt handle; without one, the SDK fetches the message by id under the deployment's OIDC token. The
 * identifiers must each be a single path segment.
 */
export function verifyPushedDeliveries(
  route: (request: Request) => Promise<Response>,
  opts: VerifyOptions,
): (request: Request) => Promise<Response> {
  const log = opts.log ?? (() => {});
  return async (request) => {
    const h = request.headers;
    const queueName = h.get('ce-vqsqueuename');
    if (h.get('ce-type') !== CLOUD_EVENT_TYPE_V2BETA || queueName === null) {
      log('queue delivery that is not a binary v2beta delivery refused', { type: h.get('ce-type') });
      return Response.json({ error: 'unsupported delivery' }, { status: 403 });
    }
    if (queueName !== opts.topic()) {
      log('queue delivery for another topic refused', { queueName });
      return Response.json({ error: 'unknown topic' }, { status: 403 });
    }
    const messageId = h.get('ce-vqsmessageid');
    const consumerGroup = h.get('ce-vqsconsumergroup');
    const receiptHandle = h.get('ce-vqsreceipthandle');
    if ([messageId, consumerGroup, receiptHandle].some((v) => v !== null && !isPathSegment(v))) {
      log('queue delivery with an identifier that is not a path segment refused', { messageId });
      return Response.json({ error: 'invalid delivery' }, { status: 403 });
    }
    if (!receiptHandle) return route(request);
    if (!messageId || !consumerGroup) return route(request); // the SDK answers 400
    const region = h.get('ce-vqsregion');
    let api = opts.api();
    // The SDK accepts only region names of this shape before it uses one in a host name; so does this.
    if (region && /^[a-z]{2,5}[0-9]{1,2}$/.test(region) && api.withRegion) api = api.withRegion(region);
    try {
      await api.changeVisibility({
        messageId,
        queueName,
        consumerGroup,
        receiptHandle,
        visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds ?? VISIBILITY_TIMEOUT_SECONDS,
      });
    } catch (error) {
      if (REFUSED.some((E) => error instanceof E)) {
        log('queue delivery with a receipt handle the service refused', { messageId });
        return Response.json({ error: 'unverified delivery' }, { status: 403 });
      }
      // The service could not be asked: answer 5xx so that a real delivery is pushed again, not lost.
      log('queue delivery could not be verified', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: 'verification unavailable' }, { status: 503 });
    }
    return route(request);
  };
}
