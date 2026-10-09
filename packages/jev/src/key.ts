import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// TypeSafe's own API, which takes the TypeSafe key in ~/.jev-key. The Vercel AI
// Gateway route (https://ai-gateway.vercel.sh/typesafe, model typesafe-ai/jev)
// wants a Gateway key and answers 401 to this one.
export const JEV_DEFAULTS = {
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  keyFile: join(homedir(), '.jev-key'),
} as const;

export type JevLink = { baseUrl: string; model: string; key: string };

// A key file is written by hand, so accept the shapes a hand makes: a bare
// token, or `NAME=value` lines, quoted or not, with notes on other lines.
// `JEV_BASE_URL` and `JEV_MODEL` lines in the file override the defaults. The
// key is returned to the caller and never printed, compared or logged here.
/** Kept for internal callers and tests, including test setup added in PR #34.
 * @public
 */
export function parseKeyFile(text: string): JevLink {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, '').trim();
  const vars = new Map<string, string>();
  const bare: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) vars.set(match[1].toUpperCase(), unquote(match[2]));
    else bare.push(unquote(line));
  }
  const keyName = ['JEV_API_KEY', 'TYPESAFE_API_KEY'].find(name => vars.get(name))
    ?? [...vars.keys()].find(name => /KEY|TOKEN/.test(name) && vars.get(name));
  return {
    baseUrl: (vars.get('JEV_BASE_URL') || JEV_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: vars.get('JEV_MODEL') || JEV_DEFAULTS.model,
    key: (keyName ? vars.get(keyName) : bare.at(-1)) ?? '',
  };
}

// The hosted page's link (docs/deploy.md). There the key is a secret set on the
// host, JEV_API_KEY, and this is the one place that reads it. Locally the key
// stays in ~/.jev-key and never enters the environment.
export function linkFromEnv(env: Record<string, string | undefined>): JevLink {
  return {
    baseUrl: (env.JEV_BASE_URL || JEV_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: env.JEV_MODEL || JEV_DEFAULTS.model,
    key: env.JEV_API_KEY?.trim() ?? '',
  };
}

// Reads the key file once. A missing file yields an empty key, which callers
// report as "Jev is offline" rather than failing.
export function readJevLink(path: string = JEV_DEFAULTS.keyFile): JevLink {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Missing or unreadable: an empty key.
  }
  return parseKeyFile(text);
}
