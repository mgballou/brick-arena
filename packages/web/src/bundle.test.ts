import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { JEV_DEFAULTS } from '../../jev/src/key';
import { JEV_PATH } from '../../jev/src/wire';

// Builds the client exactly as `pnpm build` does, with a dummy key sitting in
// the build's environment under every name the server reads, then reads every
// file that would ship. None of it may hold the key or name TypeSafe.
const DUMMY_KEY = 'test-key-not-real-bundle-7f3a';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const shipped = new Map<string, string>();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}

beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'brick-arena-dist-'));
  const saved = { ...process.env };
  // Vitest runs with NODE_ENV=test, which would build React's development copy.
  Object.assign(process.env, { NODE_ENV: 'production', JEV_API_KEY: DUMMY_KEY, TYPESAFE_API_KEY: DUMMY_KEY });
  try {
    await build({ root, mode: 'production', configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    process.env = saved;
  }
  for (const file of walk(outDir)) shipped.set(relative(outDir, file), readFileSync(file, 'utf8'));
}, 60_000);

describe('the built client', () => {
  it('ships an index and a script', () => {
    expect([...shipped.keys()]).toContain('index.html');
    expect([...shipped.keys()].some(name => name.endsWith('.js'))).toBe(true);
  });

  it('holds no key', () => {
    // Checked as booleans, so a failure names the file without printing the bundle.
    expect([...shipped].filter(([, text]) => text.includes(DUMMY_KEY)).map(([name]) => name)).toEqual([]);
  });

  it('names no TypeSafe host', () => {
    const hosts = [new URL(JEV_DEFAULTS.baseUrl).host, 'typesafe.ai', 'ai-gateway.vercel.sh', '127.0.0.1:18787'];
    const named = [...shipped].flatMap(([name, text]) => hosts.filter(host => text.includes(host)).map(host => `${name} names ${host}`));
    expect(named).toEqual([]);
  });

  it('calls only the same-origin forwarder', () => {
    const js = [...shipped].filter(([name]) => name.endsWith('.js')).map(([, text]) => text).join('\n');
    // The minifier may quote it with any of the three.
    expect(['"', "'", '`'].some(quote => js.includes(`${quote}${JEV_PATH}${quote}`))).toBe(true);
    // Every absolute URL left in the bundle is React's error link or an XML
    // namespace: none is a place the page sends a request.
    const urls = new Set(js.match(/(?:https?|wss?):\/\/[^\s"'`)]+/g) ?? []);
    const allowed = /^https:\/\/react\.dev\/errors\/|^http:\/\/www\.w3\.org\//;
    expect([...urls].filter(url => !allowed.test(url))).toEqual([]);
  });
});
