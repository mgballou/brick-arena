import { mkdtempSync, writeFileSync } from 'node:fs';
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

  it('enforces the per-visitor limit and starts fresh on a new UTC day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-cap-'));
    let day = '2026-10-01';
    const limits = { perVisitor: 1, total: 2 };
    const cap = createFileCap(dir, limits, () => day);
    expect(cap.take('a')).toBe('ok');
    expect(cap.take('a')).toBe('visitor');
    expect(cap.take('b')).toBe('ok');
    expect(cap.take('c')).toBe('total');

    day = '2026-10-02';
    expect(cap.take('a')).toBe('ok');
    expect(cap.take('a')).toBe('visitor');
    const restarted = createFileCap(dir, limits, () => day);
    expect(restarted.take('b')).toBe('ok');
    expect(restarted.take('c')).toBe('total');
  });

  it('ignores a damaged or stale saved count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-cap-'));
    const path = join(dir, 'jev-calls.json');
    const today = () => '2026-10-01';
    const limits = { perVisitor: 10, total: 1 };

    writeFileSync(path, '{not json');
    expect(createFileCap(dir, limits, today).take('a')).toBe('ok');
    writeFileSync(path, JSON.stringify({ day: '2026-09-30', count: 1 }));
    expect(createFileCap(dir, limits, today).take('b')).toBe('ok');
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

  it('falls back when the Jev call rows cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brick-arena-cap-'));
    const client = stubClient();
    client.tables.matches.push({ id: 'today', started_at: '2026-10-01T12:00:00.000Z' });
    const select = client.select.bind(client);
    client.select = async (table, query) => table === 'jev_calls'
      ? { ok: false, status: 503, message: 'calls table unavailable' }
      : select(table, query);
    const logged: string[] = [];

    const cap = await createBootCap(client, dir, { perVisitor: 10, total: 1 }, line => logged.push(line), () => '2026-10-01');
    expect(cap.take('a')).toBe('ok');
    expect(logged.join('\n')).toMatch(/calls table unavailable/);
  });
});
