import { describe, expect, it } from 'vitest';
import { ARENA } from '../../engine/src/arena.ts';
import { readConfig, syncDashboard, type PostHogConfig } from './posthog-dashboard';

type Resource = { id: number; name: string; description?: string; query?: unknown; dashboards?: number[] };

function fakePostHog() {
  const dashboards: Resource[] = [];
  const insights: Resource[] = [];
  const writes: string[] = [];
  let nextId = 1;

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const collection = url.pathname.includes('/dashboards/') ? dashboards : insights;
    const collectionName = url.pathname.includes('/dashboards/') ? 'dashboard' : 'insight';
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

    if (method === 'GET') return response({ results: collection, next: null });

    const resourceMatch = url.pathname.match(/\/(dashboards|insights)\/(\d+)\/$/);
    if (method === 'POST') {
      writes.push(`${method} ${collectionName}`);
      const resource = { id: nextId++, ...JSON.parse(String(init.body)) };
      collection.push(resource);
      return response(resource, 201);
    }
    if (method === 'PATCH' && resourceMatch) {
      writes.push(`${method} ${collectionName}`);
      const resource = collection.find(item => item.id === Number(resourceMatch[2]));
      if (!resource) return response({ detail: 'not found' }, 404);
      Object.assign(resource, JSON.parse(String(init.body)));
      return response(resource);
    }
    return response({ detail: `unexpected ${method} ${url.pathname}` }, 404);
  };

  return { dashboards, insights, writes, fetcher };
}

const config: PostHogConfig = {
  host: 'https://us.posthog.com',
  projectId: '42',
  personalApiKey: 'test-key',
};

describe('PostHog dashboard setup', () => {
  it('creates four insights on one Brick Arena dashboard and makes no writes on a second run', async () => {
    const fake = fakePostHog();

    await syncDashboard(config, fake.fetcher);
    expect(fake.dashboards.map(({ name }) => name)).toEqual(['Brick Arena']);
    expect(fake.insights).toHaveLength(4);
    expect(fake.insights.every(({ dashboards }) => dashboards?.includes(fake.dashboards[0].id))).toBe(true);
    const initialWrites = [...fake.writes];

    await syncDashboard(config, fake.fetcher);

    expect(fake.writes).toEqual(initialWrites);
    expect(fake.dashboards).toHaveLength(1);
    expect(fake.insights).toHaveLength(4);
  });

  it('filters level_started on every level the engine emits, counted from 0', async () => {
    const fake = fakePostHog();
    await syncDashboard(config, fake.fetcher);

    const levels = JSON.stringify(fake.insights.map(({ query }) => query))
      .match(/"key":"level","value":\[[^\]]*\]/g) ?? [];
    expect(levels).toContain(`"key":"level","value":${JSON.stringify(Array.from({ length: ARENA.levels }, (_, i) => i))}`);
  });

  it('reports the missing environment variable by name', () => {
    expect(() => readConfig({ POSTHOG_HOST: config.host, POSTHOG_PROJECT_ID: config.projectId }))
      .toThrow('Missing required environment variable: POSTHOG_PERSONAL_API_KEY');
  });
});
