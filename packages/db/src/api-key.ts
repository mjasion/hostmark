const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 hex of an API key: what `api_keys.key_hash` stores. Web Crypto, so it runs on Workers too. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return toHex(new Uint8Array(digest));
}

export function generateApiKey(): string {
  return `hm_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}
