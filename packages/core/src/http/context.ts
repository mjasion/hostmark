import type { CoreDeps } from '../deps';

export interface Principal {
  userId: string;
  /** Null for cookie sessions (D7). */
  apiKeyId: string | null;
  isAdmin: boolean;
}

export type HttpEnv = {
  Variables: {
    deps: CoreDeps;
    traceId: string;
    principal: Principal;
  };
};
