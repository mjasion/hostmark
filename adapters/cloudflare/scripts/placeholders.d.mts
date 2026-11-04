export const PLACEHOLDER_HYPERDRIVE_ID: string;
export function placeholderProblems(
  name: string,
  config: {
    vars?: Record<string, unknown>;
    account_id?: unknown;
    hyperdrive?: { binding?: string; id?: unknown }[];
  },
  options?: { skip?: 'hyperdrive'[] },
): string[];
