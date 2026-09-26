import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForDecision, createBoard } from '../../engine/src/index';
import { DOWN_STATUS, type Down } from '../../jev/src/wire';
import { askJev, probeJev } from './jev';
import { Root } from './main';

// What the forwarder sends when Jev can't answer, as the browser's fetch sees it.
const downReply = (down: Down) => vi.fn(async () => new Response(JSON.stringify({ ok: false, down }), { status: DOWN_STATUS, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());
const downProbe = (down: Down) => ({ ok: false as const, reason: 'Jev is down.', down });

describe('the down status', () => {
  for (const down of ['unreachable', 'used-up'] as const) {
    it(`reads ${down} from the check before a match`, async () => {
      vi.stubGlobal('fetch', downReply(down));
      expect(await probeJev()).toMatchObject({ ok: false, down });
    });

    it(`reads ${down} from a call mid-match`, async () => {
      vi.stubGlobal('fetch', downReply(down));
      expect(await askJev(askForDecision(createBoard(3, 0)))).toMatchObject({ ok: false, kind: 'down', down });
    });
  }

  it('leaves any other failure to the title screen and the pause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":false,"error":"That ask was not JSON."}', { status: 400 })));
    const probe = await probeJev();
    expect(probe).toEqual({ ok: false, reason: 'That ask was not JSON.' });
  });
});

describe('the down page', () => {
  it('names the game, says it is down because Jev cannot be reached, and says to try later', () => {
    const html = renderToString(<Root initial={downProbe('unreachable')} />);
    expect(html).toContain('Brick<span>Arena</span>');
    expect(html).toContain('The game is down right now');
    expect(html).toContain('Jev can&#x27;t be reached');
    expect(html).toContain('Please try again later.');
    expect(html).not.toContain('plays are used up');
  });

  it('never mounts the board, and never offers the stand-in', () => {
    for (const down of ['unreachable', 'used-up'] as const) {
      const html = renderToString(<Root initial={downProbe(down)} />);
      expect(html).not.toContain('<canvas');
      expect(html).not.toMatch(/class="(hud|arena|board)/);
      expect(html.toLowerCase()).not.toContain('stand-in');
      expect(html.toLowerCase()).not.toContain('debug');
    }
  });

  it('adds that the day\'s plays are used up past the cap', () => {
    const html = renderToString(<Root initial={downProbe('used-up')} />);
    expect(html).toContain('The game is down right now');
    expect(html).toContain('Today&#x27;s plays are used up.');
  });

  it('mounts no board while the first check runs', () => {
    const html = renderToString(<Root />);
    expect(html).toContain('Reaching Jev');
    expect(html).not.toContain('<canvas');
  });

  it('mounts the boards once Jev answers', () => {
    expect(renderToString(<Root initial={{ ok: true, ms: 700, answeredBy: 'live' }} />)).toContain('<canvas');
  });
});
