import { describe, expect, it } from 'vitest';
import { isBackstagePath } from './admin';

describe('the backstage page path', () => {
  it.each([
    '/matches',
    '/matches.html',
    '/matches.html/',
    '/matches%2ehtml',
    '/matches%2Ehtml',
    '/Matches.html',
    '/MATCHES.HTML',
    '/Matches',
    '/MATCHES',
    '/matches/',
    '/matches.HTML',
    '/%6datches.html',
    '/%4dATCHES.HTML',
    '/matches.html%2f',
    '/matches.html//',
    '/%2fmatches.html',
    '//matches.html',
    '/foo%2f..%2fmatches.html',
    '/foo/%2e%2e/matches.html',
    '/@fs/tmp/brick-arena/matches.html',
    '/@fs/tmp/brick-arena/Matches.html',
    '/@fs/tmp/brick-arena/matches%2ehtml',
    '/@fs/tmp/brick-arena/matches.html/',
    '/@fs/../tmp/brick-arena/matches.html',
  ])('recognizes %s', path => {
    expect(isBackstagePath(path)).toBe(true);
  });

  it.each(['/', '/index.html', '/matches.json', '/matches.html.json', '/other/matches.html', '/matches%252ehtml', '/@fs/tmp/brick-arena/index.html', '/@fs/tmp/brick-arena/matches.json'])('leaves %s public', path => {
    expect(isBackstagePath(path)).toBe(false);
  });

  it('does not throw on a malformed escape', () => {
    expect(() => isBackstagePath('/%E0%A4%A')).not.toThrow();
    expect(isBackstagePath('/%E0%A4%A')).toBe(false);
  });
});
