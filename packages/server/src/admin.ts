import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';

// The backstage: /matches.html and every read of a match record answer only
// the admin. The admin is whoever sends ADMIN_SECRET as the password of HTTP
// Basic auth (any user name), so a browser asks for it once and then sends it
// with the page's own reads. The secret lives only in the server's
// environment; nothing in the client knows it. With no secret set there is no
// backstage at all, and those routes answer 404.
//
//   ADMIN_SECRET=... pnpm match --from https://<your service>
const ADMIN_REALM = 'Brick Arena backstage';
// The page that reads match records. Its built script holds no data.
export const BACKSTAGE_PAGE = '/matches.html';

export function isBackstagePath(path: string): boolean {
  let decoded: string;
  let normalized: string;
  try {
    // Vite decodes paths before reading files. Match that view, including
    // encoded separators and dot segments, on a case-insensitive dev disk.
    decoded = decodeURIComponent(path).toLowerCase();
    normalized = posix.normalize(decoded).replace(/\/+$/, '');
  } catch {
    return false;
  }
  // Vite's /@fs/ URLs can read the same page by its absolute file path.
  return normalized === BACKSTAGE_PAGE
    || normalized === BACKSTAGE_PAGE.slice(0, -'.html'.length)
    || (decoded.startsWith('/@fs/') && posix.basename(normalized) === BACKSTAGE_PAGE.slice(1));
}

export function adminSecretFromEnv(env: Record<string, string | undefined>): string | null {
  return env.ADMIN_SECRET?.trim() || null;
}

// The header a reader sends: Basic, user `admin`.
export const adminHeader = (secret: string) => `Basic ${Buffer.from(`admin:${secret}`).toString('base64')}`;

const digest = (text: string) => createHash('sha256').update(text).digest();

function passwordOf(req: IncomingMessage): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

// Compared as hashes, so the time taken says nothing about the secret.
function isAdmin(req: IncomingMessage, secret: string | null): boolean {
  const password = passwordOf(req);
  return secret !== null && password !== null && timingSafeEqual(digest(password), digest(secret));
}

// Answers a request that isn't the admin's, and says whether it did. The body
// holds nothing from the store either way.
export function refuseUnlessAdmin(req: IncomingMessage, res: ServerResponse, secret: string | null): boolean {
  if (isAdmin(req, secret)) return false;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  if (secret === null) {
    res.statusCode = 404;
    res.end('Not found');
  } else {
    res.statusCode = 401;
    res.setHeader('www-authenticate', `Basic realm="${ADMIN_REALM}", charset="UTF-8"`);
    res.end('Unauthorized');
  }
  return true;
}
