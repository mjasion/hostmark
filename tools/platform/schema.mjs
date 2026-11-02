import { z } from 'zod';

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'a secret is named in upper snake case');

const platform = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'a name is lower case letters, digits and dashes'),
  enabled: z.boolean(),
  adapter: z
    .string()
    .regex(/^adapters\/[a-z][a-z0-9-]*$/, 'an adapter is a directory directly under adapters/'),
  status: z.enum(['emulated', 'deployed']),
  secrets: z
    .array(secretName)
    .refine((names) => new Set(names).size === names.length, 'a secret is listed once'),
});

export const platformsFile = z.strictObject({
  platforms: z
    .array(platform)
    .min(1)
    .refine((list) => new Set(list.map((p) => p.name)).size === list.length, 'a platform is listed once'),
});

/** Parses the text of platforms.json; throws a ZodError that names the offending path. */
export function parsePlatforms(text) {
  return platformsFile.parse(JSON.parse(text)).platforms;
}
