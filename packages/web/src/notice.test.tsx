import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Consent } from './consent';
import { Notice, Root } from './main';

// The notice as docs/specs/data-collection.md writes it.
const LINE = 'This game records how each match plays, using PostHog and Supabase, and never who you are.';

describe('the title screen\'s notice', () => {
  it('says the line as written, links the privacy page and offers the opt-out beside it', () => {
    const html = renderToString(<Notice consent={new Consent(null, false)} />);
    expect(html).toContain(LINE);
    expect(html).toContain('href="/privacy.html"');
    expect(html).toMatch(/<button[^>]*>Opt out<\/button>/);
  });

  it('offers to opt back in once opted out', () => {
    const consent = new Consent(null, false);
    consent.optOut();
    const html = renderToString(<Notice consent={consent} />);
    expect(html).toContain('You opted out: this browser records nothing.');
    expect(html).toMatch(/<button[^>]*>Opt back in<\/button>/);
    expect(html).toContain('href="/privacy.html"');
  });

  it('names Do Not Track and offers no button under it', () => {
    const html = renderToString(<Notice consent={new Consent(null, true)} />);
    expect(html).toContain('Do Not Track is on, so this browser records nothing.');
    expect(html).not.toContain('<button');
  });

  it('shows on the title screen', () => {
    const html = renderToString(<Root initial={{ ok: true, ms: 640, answeredBy: 'live' }} />);
    expect(html).toContain(LINE);
  });
});
