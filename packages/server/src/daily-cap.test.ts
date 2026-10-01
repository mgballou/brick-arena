import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBootCap, createFileCap, createSupabaseCap, supabaseDailyCount } from './daily-cap';
import { stubClient } from './supabase';

describe('the persisted daily cap', () => {
  it('keeps the total after creating a new cap from the same data directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-cap-'));
    const today = () => '2026-10-01';
    const limits = { perVisitor: 10, total: 2 };
    const first = createFileCap(dir, limits, today);
    expect(first.take('a')).toBe('ok');
    expect(first.take('b')).toBe('ok');

    const restarted = createFileCap(dir, limits, today);
    expect(restarted.take('c')).toBe('total');
  });

  it('loads today’s Jev call rows from Supabase and skips older matches', async () => {
    const client = stubClient();
    client.tables.matches.push(
      { id: 'today', started_at: '2026-10-01T12:00:00.000Z' },
      { id: 'yesterday', started_at: '2026-09-30T23:59:59.000Z' },
    );
    client.tables.jev_calls.push(
      { match_id: 'today', n: 0 },
      { match_id: 'today', n: 1 },
      { match_id: 'yesterday', n: 0 },
    );

    expect(await supabaseDailyCount(client, '2026-10-01')).toBe(2);
    const restarted = await createSupabaseCap(client, { perVisitor: 10, total: 2 }, () => '2026-10-01');
    expect(restarted.take('a')).toBe('total');
  });

  it('counts in the data directory when Supabase cannot be read at boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-cap-'));
    const client = stubClient();
    client.refuse({ ok: false, status: 540, message: 'project paused' });
    const logged: string[] = [];
    const limits = { perVisitor: 10, total: 1 };
    const cap = await createBootCap(client, dir, limits, line => logged.push(line), () => '2026-10-01');
    expect(cap.take('a')).toBe('ok');
    expect(logged.join('\n')).toMatch(/project paused/);

    const restarted = await createBootCap(client, dir, limits, () => {}, () => '2026-10-01');
    expect(restarted.take('b')).toBe('total');
  });
});
