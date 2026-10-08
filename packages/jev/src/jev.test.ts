import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForDecision, botPlayer, createBoard, landingX, type Ask, type BoardState, type Decision, type Player } from '../../engine/src/index';
import { JEV_DEFAULTS, linkFromEnv, parseKeyFile } from './key';
import { jevPlayer, jevPlayerFromKeyFile } from './player';
import { raceWithLatency, summarize, TICK_MS } from './race';
import { SYNTHETIC, syntheticRecording } from './synthetic';
import { httpTransport, readRecording, recordingTransport, replayTransport } from './transport';
import { POINTS } from '../../engine/src/arena';
import { alwaysLanding, clearFast } from './stand-in';
import { fromResponse, OBJECTIVE, toRequest } from './wire';

function keyFile(text: string) {
  const path = join(mkdtempSync(join(tmpdir(), 'jev-key-')), 'key');
  writeFileSync(path, text);
  return path;
}
const link = { keyFile: keyFile('test-key-not-real\n'), baseUrl: 'https://jev.example', model: 'jev-test' };
const choose = (choice: string) => ({ answers: { decision: { type: 'choice', choice } } });

function askWith(question: Ask['question']): Ask {
  const state = createBoard(3, 4);
  if (question === 'chase') state.powerUps.push({ id: 'power-1', kind: 'short-paddle', x: 90, y: 120, vy: 1.2 });
  if (question === 'track') state.balls.push({ ...state.balls[0], id: 'ball-1', x: 60, tracked: false });
  const ask = askForDecision(state);
  expect(ask.question).toBe(question);
  return ask;
}

afterEach(() => vi.unstubAllGlobals());

describe('the key file', () => {
  it('reads a bare token and falls back to TypeSafe defaults', () => {
    expect(parseKeyFile('  tok-123  \n')).toEqual({ baseUrl: JEV_DEFAULTS.baseUrl, model: JEV_DEFAULTS.model, key: 'tok-123' });
    expect(JEV_DEFAULTS).toMatchObject({ baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' });
  });

  it('reads NAME=value lines, quotes and overrides included', () => {
    expect(parseKeyFile('# mine\nJEV_BASE_URL=https://x.example/\nJEV_API_KEY="tok-1"\nJEV_MODEL=jev-2\n')).toEqual({ baseUrl: 'https://x.example', model: 'jev-2', key: 'tok-1' });
    expect(parseKeyFile("export TYPESAFE_API_KEY='tok-2'\n").key).toBe('tok-2');
    expect(parseKeyFile('').key).toBe('');
  });

  it('uses the preferred key when both names are present and accepts other token names', () => {
    expect(parseKeyFile('TYPESAFE_API_KEY=older\nJEV_API_KEY=preferred\n').key).toBe('preferred');
    expect(parseKeyFile('MY_SERVICE_TOKEN=custom\n').key).toBe('custom');
  });

  it('reads hosted overrides and trims the secret', () => {
    expect(linkFromEnv({ JEV_BASE_URL: 'https://host.example///', JEV_MODEL: 'jev-hosted', JEV_API_KEY: ' hosted-key \n' })).toEqual({
      baseUrl: 'https://host.example', model: 'jev-hosted', key: 'hosted-key',
    });
  });
});

describe('construction from the key file', () => {
  it('refuses to build without a key', () => {
    expect(() => jevPlayerFromKeyFile({ keyFile: keyFile('') })).toThrow(/needs a TypeSafe key/);
    expect(() => jevPlayerFromKeyFile({ keyFile: join(tmpdir(), 'no-such-jev-key') })).toThrow(/needs a TypeSafe key/);
  });

  it('constructs without calling anything', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(jevPlayerFromKeyFile(link).name).toBe('Jev (jev-test)');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('mapping each question onto one Choice', () => {
  it('target: four named catches, answered with the matching x', () => {
    const ask = askWith('target');
    const question = toRequest(ask, 'm').questions.decision;
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria)).toEqual(['landing', 'aim', 'angle-left', 'angle-right']);
    expect(fromResponse(ask, choose('landing'))).toEqual({ kind: 'target', x: ask.options[0] });
    expect(fromResponse(ask, choose('aim'))).toEqual({ kind: 'target', x: ask.options[1] });
    expect(fromResponse(ask, choose('angle-left'))).toEqual({ kind: 'target', x: ask.options[2] });
    expect(question.criteria.aim).toMatch(/densest bricks it can reach/);
  });

  it('opens every question with the objective and the scoring', () => {
    for (const kind of ['target', 'chase', 'track'] as const) {
      const { instructions } = toRequest(askWith(kind), 'm').questions.decision;
      expect(instructions.startsWith(OBJECTIVE)).toBe(true);
    }
    expect(OBJECTIVE).toContain(`${POINTS.percentCleared} per percent`);
    expect(OBJECTIVE).toContain(`${POINTS.secondLeft} per second left`);
    expect(OBJECTIVE).toMatch(/first to break every breakable brick wins/);
    expect(OBJECTIVE).toMatch(/lost ball scores nothing/);
    expect(OBJECTIVE).toMatch(/keep the ball first/);
  });

  it('shows where each ball comes down, and which power-ups cost the ball', () => {
    const state = askWith('chase').state;
    Object.assign(state.balls[0], { x: 400, y: 200, vx: 0, vy: 2.6 });
    state.powerUps.push({ id: 'power-2', kind: 'extra-ball', x: 380, y: 250, vy: 1.2 });
    const ask = askForDecision(state);
    const request = toRequest(ask, 'm');
    const sent = request.state as { balls: Array<{ landsAt: { x: number; inTicks: number } }>; powerUps: Array<{ id: string; keepsBall: boolean }> };
    expect(sent.balls[0].landsAt.x).toBeCloseTo(400);
    expect(sent.balls[0].landsAt.inTicks).toBe(34);
    expect(sent.powerUps.map(power => [power.id, power.keepsBall])).toEqual([['power-1', false], ['power-2', true]]);
    expect(request.questions.decision.criteria['power-1']).toMatch(/going for it loses the ball/);
    expect(request.questions.decision.criteria['power-2']).toMatch(/can still get back under the ball/);
  });

  it('chase: each falling power-up by id, plus none', () => {
    const ask = askWith('chase');
    expect(Object.keys(toRequest(ask, 'm').questions.decision.criteria)).toEqual(['power-1', 'none']);
    expect(fromResponse(ask, choose('power-1'))).toEqual({ kind: 'chase', powerUpId: 'power-1' });
    expect(fromResponse(ask, choose('none'))).toEqual({ kind: 'target', x: landingX(ask.state, ask.state.balls[0]) });
  });

  it('track: each ball by id', () => {
    const ask = askWith('track');
    expect(Object.keys(toRequest(ask, 'm').questions.decision.criteria)).toEqual(['ball-0', 'ball-1']);
    expect(fromResponse(ask, choose('ball-1'))).toEqual({ kind: 'track', ballId: 'ball-1' });
  });

  it('refuses an answer outside the offered set or of another type', () => {
    const ask = askWith('target');
    expect(() => fromResponse(ask, choose('ball-0'))).toThrow(/outside the offered set/);
    expect(() => fromResponse(ask, { answers: { decision: { type: 'noul', noul: 0.9 } } })).toThrow(/not a choice/);
  });
});

describe('the stand-in rules', () => {
  it('aims every catch, goes only for power-ups that speed a clear and keep the ball, and plays the lowest falling ball', () => {
    expect(clearFast(toRequest(askWith('target'), 'm'))).toBe('aim');
    expect(alwaysLanding(toRequest(askWith('target'), 'm'))).toBe('landing');
    expect(clearFast(toRequest(askWith('chase'), 'm'))).toBe('none');
    const extra = askWith('chase');
    extra.state.powerUps.push({ id: 'power-2', kind: 'extra-ball', x: 420, y: 100, vy: 1.2 });
    expect(clearFast(toRequest(askForDecision(extra.state), 'm'))).toBe('power-2');
    const falling = (state: BoardState) => { Object.assign(state.balls[0], { x: 400, y: 200, vx: 0, vy: 2.6 }); return state; };
    const far = askWith('chase');
    far.state.powerUps.push({ id: 'power-2', kind: 'extra-ball', x: 60, y: 250, vy: 1.2 });
    expect(clearFast(toRequest(askForDecision(falling(far.state)), 'm'))).toBe('none');
    const near = askWith('chase');
    near.state.powerUps.push({ id: 'power-2', kind: 'extra-ball', x: 380, y: 250, vy: 1.2 });
    expect(clearFast(toRequest(askForDecision(falling(near.state)), 'm'))).toBe('power-2');
    const track = askWith('track');
    track.state.balls[0].vy = -2;
    track.state.balls[1].vy = 2;
    expect(clearFast(toRequest(askForDecision(track.state), 'm'))).toBe('ball-1');
  });
});

describe('transport', () => {
  it('posts to /v1/systemone with a bearer key and records the call without the key', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(choose('aim')), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const path = join(mkdtempSync(join(tmpdir(), 'jev-')), 'calls.ndjson');
    const player = jevPlayerFromKeyFile({ ...link, recordTo: path });

    const ask = askWith('target');
    expect((await player.decide(ask)).decision).toEqual({ kind: 'target', x: ask.options[1] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://jev.example/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key-not-real');

    const [record] = readRecording(path);
    expect(record).toMatchObject({ synthetic: false, request: toRequest(ask, 'jev-test'), response: choose('aim') });
    expect(typeof record.ms).toBe('number');
    expect(readFileSync(path, 'utf8')).not.toContain('test-key-not-real');
  });

  it('surfaces the documented error shape', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'questions.decision.type: bad', error_type: 'invalid_request' }), { status: 400 }));
    await expect(httpTransport({ baseUrl: 'https://x.example/', apiKey: 'k' })(toRequest(askWith('target'), 'm'))).rejects.toThrow('Jev 400 invalid_request: questions.decision.type: bad');
  });

  it('records failures as well as answers', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jev-')), 'calls.ndjson');
    const transport = recordingTransport(async () => { throw new Error('refused'); }, path);
    await expect(transport(toRequest(askWith('target'), 'm'))).rejects.toThrow('refused');
    expect(readRecording(path)[0]).toMatchObject({ error: 'refused' });
  });

  it('replays only the requests it recorded', async () => {
    const ask = askWith('target');
    const replay = replayTransport([{ synthetic: true, at: null, request: toRequest(ask, 'm'), response: choose('right'), ms: null }]);
    await expect(replay(toRequest(askWith('chase'), 'm'))).rejects.toThrow('does not match the recording');
    expect(await replay(toRequest(ask, 'm'))).toEqual(choose('right'));
    await expect(replay(toRequest(ask, 'm'))).rejects.toThrow('recording exhausted');
  });
});

describe('the synthetic recording', () => {
  const records = readRecording('docs/jev-calls.synthetic.ndjson');

  it('is labeled synthetic on every line and carries no time', () => {
    expect(records.every(record => record.synthetic === true && record.at === null && record.ms === null)).toBe(true);
  });

  it('is exactly what the documented-shape generator writes', async () => {
    expect(JSON.parse(JSON.stringify(await syntheticRecording()))).toEqual(records);
  });

  it('plays a whole level through the adapter, all three questions and one failure included', async () => {
    const result = await raceWithLatency(jevPlayer({ model: SYNTHETIC.model, transport: replayTransport(records) }), { seed: SYNTHETIC.seed, level: SYNTHETIC.level, now: () => 0 });
    expect(new Set(result.calls.map(call => call.question))).toEqual(new Set(['target', 'chase', 'track']));
    expect(result.calls).toHaveLength(records.length);
    expect(result.calls.filter(call => call.outcome === 'error')).toHaveLength(1);
    expect(result.state.completed).toBe(true);
  });
});

describe('a slow or failed decision never holds the board', () => {
  const target: Decision = { kind: 'target', x: 300 };

  it('an 800 ms answer lands 48 ticks late, and the cost shows in the result', async () => {
    let clock = 0;
    const slow: Player = { name: 'slow', decide: async () => { clock += 800; return { decision: target, ms: 800 }; } };
    const result = await raceWithLatency(slow, { seed: 5, level: 0, maxTicks: 600, now: () => clock });
    const bot = await raceWithLatency(botPlayer(), { seed: 5, level: 0, maxTicks: 600 });

    expect(result.state.tick).toBe(bot.state.tick);
    expect(Math.ceil(800 / TICK_MS)).toBe(48);
    expect(result.calls.every(call => call.appliedAt === null || call.appliedAt - call.askedAt === 48)).toBe(true);
    expect(result.missedAsks.length).toBeGreaterThan(0);
    expect(summarize(result)).toMatchObject({ msMedian: 800, missedAsks: result.missedAsks.length, lateTicks: 48 * summarize(result).applied });
  });

  it('keeps stepping in real time while a real 800 ms call is out', async () => {
    const slow: Player = { name: 'slow', decide: () => new Promise(resolve => setTimeout(() => resolve({ decision: target, ms: 800 }), 800)) };
    const result = await raceWithLatency(slow, { seed: 5, level: 0, maxTicks: 89 });

    expect(result.state.tick).toBe(89);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].ms).toBeGreaterThanOrEqual(790);
    expect(result.calls[0].appliedAt).toBeGreaterThanOrEqual(30 + 48);
    expect(result.missedAsks).toEqual([60]);
    expect(result.state.paddleTargetX).toBe(300);
  });

  it('a call past the deadline is a timeout: nothing applied, board moves on', async () => {
    const hung: Player = { name: 'hung', decide: () => new Promise(() => undefined) };
    const result = await raceWithLatency(hung, { seed: 5, level: 0, maxTicks: 60, deadlineMs: 20 });
    expect(result.state.tick).toBe(60);
    expect(result.calls.map(call => [call.outcome, call.ms, call.appliedAt])).toEqual([['timeout', 20, null], ['timeout', 20, null]]);
    expect(result.state.paddleTargetX).toBe(createBoard(5, 0).paddleTargetX);
  });

  it('a failed call is an error: nothing applied, board moves on', async () => {
    const broken: Player = { name: 'broken', decide: async () => { throw new Error('503'); } };
    const result = await raceWithLatency(broken, { seed: 5, level: 0, maxTicks: 60, now: () => 0 });
    expect(summarize(result)).toMatchObject({ ticks: 60, calls: 2, applied: 0, errors: 2 });
    expect(result.calls[0].error).toBe('503');
  });
});
