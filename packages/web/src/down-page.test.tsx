import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Checking, DownPage } from './down';
import { probeJev, type Probe } from './jev';

// The page has no DOM here, so its one hook is stood in for: `state.checking`
// is what useState hands back, and `setChecking` records what the click sets.
const state = vi.hoisted(() => ({ checking: false, log: [] as string[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: (() => [state.checking, (value: boolean) => state.log.push(`checking=${value}`)]) as unknown as typeof actual.useState };
});
vi.mock('./jev', () => ({ probeJev: vi.fn() }));

function find(node: ReactNode, type: string): ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  return node.type === type ? node as never : find(node.props.children, type);
}

const stillDown: Probe = { ok: false, reason: 'Jev is down.', down: 'unreachable' };
const back: Probe = { ok: true, ms: 650, answeredBy: 'live' };

beforeEach(() => {
  state.checking = false;
  state.log = [];
  vi.mocked(probeJev).mockReset();
});

describe('Check again', () => {
  it('asks Jev once, then hands the result to the page, with the button held while it waits', async () => {
    const onProbe = vi.fn((probe: Probe) => { state.log.push(`onProbe ok=${probe.ok}`); });
    vi.mocked(probeJev).mockImplementation(async () => { state.log.push('probe'); return back; });

    const button = find(DownPage({ down: 'unreachable', onProbe }), 'button');
    expect(button?.props.disabled).toBe(false);
    button!.props.onClick!();
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalled());

    expect(probeJev).toHaveBeenCalledTimes(1);
    expect(onProbe).toHaveBeenCalledWith(back);
    expect(state.log).toEqual(['checking=true', 'probe', 'checking=false', 'onProbe ok=true']);
  });

  it('hands over a probe that is still down, so the page stays up with its reason', async () => {
    const onProbe = vi.fn();
    vi.mocked(probeJev).mockResolvedValue(stillDown);
    find(DownPage({ down: 'unreachable', onProbe }), 'button')!.props.onClick!();
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledWith(stillDown));
  });

  it('reads Checking… on a disabled button while a check runs', () => {
    state.checking = true;
    const button = find(DownPage({ down: 'unreachable', onProbe: vi.fn() }), 'button');
    expect(button?.props.disabled).toBe(true);
    const html = renderToString(<DownPage down="unreachable" onProbe={vi.fn()} />);
    expect(html).toContain('Checking…');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain('Check again');
  });

  it('reads Check again on an enabled button otherwise', () => {
    const html = renderToString(<DownPage down="unreachable" onProbe={vi.fn()} />);
    expect(html).toContain('Check again');
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });
});

describe('the down page\'s alert', () => {
  it('is announced as an alert, and the first check as a status', () => {
    expect(renderToString(<DownPage down="used-up" onProbe={vi.fn()} />)).toContain('role="alert"');
    const html = renderToString(<Checking />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Reaching Jev…');
    expect(html).not.toContain('<button');
  });

  it('draws the wall of bricks hidden from screen readers, with one brick knocked out', () => {
    const html = renderToString(<DownPage down="unreachable" onProbe={vi.fn()} />);
    expect(html).toContain('class="wall" aria-hidden="true"');
    expect(html.match(/class="gone"/g)).toHaveLength(1);
    expect(html.match(/<i /g)!.length).toBeGreaterThan(3);
  });
});
