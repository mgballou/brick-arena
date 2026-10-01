import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ARENA } from '../../engine/src/arena.ts';

type JsonObject = Record<string, unknown>;
type PostHogResource = {
  id: number;
  name?: string | null;
  derived_name?: string | null;
  description?: string | null;
  query?: unknown;
  dashboards?: number[];
};
type Page<T> = { results: T[]; next: string | null };

export type PostHogConfig = {
  host: string;
  projectId: string;
  personalApiKey: string;
};

type PropertyFilter = { key: string; value: string | number | number[]; type: 'event'; operator?: 'exact' | 'is_not' };
type EventSeries = {
  kind: 'EventsNode';
  event: string;
  custom_name?: string;
  math?: 'total' | 'median' | 'p95';
  math_property?: string;
  properties?: PropertyFilter[];
};
type Breakdown = { property: string; type: 'event'; histogram_bin_count?: number };
type InsightDefinition = {
  name: string;
  description: string;
  query: JsonObject;
};

const DASHBOARD_NAME = 'Brick Arena';
const DASHBOARD_DESCRIPTION = 'The four product questions in docs/specs/data-collection.md.';

export function readConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): PostHogConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };

  const host = required('POSTHOG_HOST').replace(/\/$/, '');
  if (host !== 'https://us.posthog.com' && host !== 'https://eu.posthog.com') {
    throw new Error('POSTHOG_HOST must be https://us.posthog.com or https://eu.posthog.com.');
  }
  const projectId = required('POSTHOG_PROJECT_ID');
  if (!/^\d+$/.test(projectId)) throw new Error('POSTHOG_PROJECT_ID must be a numeric PostHog project ID.');

  return {
    host,
    projectId,
    personalApiKey: required('POSTHOG_PERSONAL_API_KEY'),
  };
}

const eventFilter = (key: string, value: PropertyFilter['value'], operator: PropertyFilter['operator'] = 'exact'): PropertyFilter => ({
  key,
  value,
  type: 'event',
  ...(operator === 'exact' ? {} : { operator }),
});

const event = (name: string, customName?: string, math?: EventSeries['math'], mathProperty?: string, properties?: PropertyFilter[]): EventSeries => ({
  kind: 'EventsNode',
  event: name,
  ...(customName ? { custom_name: customName } : {}),
  ...(math ? { math } : {}),
  ...(mathProperty ? { math_property: mathProperty } : {}),
  ...(properties ? { properties } : {}),
});

const trends = (series: EventSeries[], options: JsonObject = {}): JsonObject => ({
  kind: 'InsightVizNode',
  source: {
    kind: 'TrendsQuery',
    series,
    interval: 'week',
    ...options,
  },
});

const definitions: InsightDefinition[] = [
  {
    name: 'How often does Jev aim?',
    description: 'Target decisions by Jev choice, level, and build.',
    query: trends(
      [event('jev_decision')],
      {
        properties: [eventFilter('question', 'target')],
        breakdownFilter: {
          breakdowns: [
            { property: 'choice', type: 'event' },
            { property: 'level', type: 'event' },
            { property: 'build', type: 'event' },
          ],
        },
      },
    ),
  },
  {
    name: 'Where do players lose balls?',
    description: 'Human ball losses by level, with histograms for x and elapsed seconds.',
    query: trends(
      [event('ball_lost')],
      {
        properties: [eventFilter('side', 'human')],
        breakdownFilter: {
          breakdowns: [
            { property: 'level', type: 'event' },
            { property: 'x', type: 'event', histogram_bin_count: 12 },
            { property: 'seconds_in', type: 'event', histogram_bin_count: 12 },
          ],
        },
      },
    ),
  },
  {
    name: 'How long do sessions last, and where do people stop?',
    description: `Session-start to match-end funnel, split into PostHog session-duration bins; level_started accepts levels 0 through ${ARENA.levels - 1}.`,
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'FunnelsQuery',
        series: [
          event('session_started'),
          event('match_started'),
          event('level_started', undefined, undefined, undefined, [eventFilter('level', Array.from({ length: ARENA.levels }, (_, level) => level))]),
          event('match_ended'),
        ],
        interval: 'week',
        funnelsFilter: {
          funnelOrderType: 'ordered',
          funnelVizType: 'steps',
          funnelWindowInterval: 14,
          funnelWindowIntervalUnit: 'day',
        },
        breakdownFilter: {
          breakdown: '$session_duration',
          breakdown_type: 'session',
          breakdown_histogram_bin_count: 12,
        },
      },
    },
  },
  {
    name: 'How fast does Jev answer, and what does late cost?',
    description: 'Median and 95th percentile answer_ms, plus the share of decisions whose outcome is not answered.',
    query: trends(
      [
        event('jev_decision', 'Median answer time', 'median', 'answer_ms'),
        event('jev_decision', '95th percentile answer time', 'p95', 'answer_ms'),
        event('jev_decision', 'All decisions', 'total'),
        event('jev_decision', 'Not answered', 'total', undefined, [eventFilter('outcome', 'answered', 'is_not')]),
      ],
      { trendsFilter: { formula: 'D/C*100', aggregationAxisFormat: 'percentage' } },
    ),
  },
];

function matchesDesired(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return Array.isArray(actual) && actual.length === desired.length && desired.every((value, index) => matchesDesired(actual[index], value));
  }
  if (desired !== null && typeof desired === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(desired).every(([key, value]) => matchesDesired((actual as JsonObject)[key], value));
  }
  return actual === desired;
}

function resourceName(resource: PostHogResource): string | null {
  return resource.name ?? resource.derived_name ?? null;
}

function namedResource(resources: PostHogResource[], name: string, resourceType: string): PostHogResource | undefined {
  const matches = resources.filter(resource => resourceName(resource) === name);
  if (matches.length > 1) throw new Error(`More than one ${resourceType} is named "${name}" in this PostHog project.`);
  return matches[0];
}

export async function syncDashboard(config: PostHogConfig, fetcher: typeof fetch = fetch): Promise<{ created: number; updated: number; unchanged: number }> {
  const projectPath = `/api/projects/${encodeURIComponent(config.projectId)}`;
  const apiRoot = `${config.host}${projectPath}`;

  const request = async <T>(url: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.personalApiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`PostHog ${method} ${new URL(url).pathname} failed with HTTP ${response.status}.`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };

  const list = async (path: string): Promise<PostHogResource[]> => {
    const resources: PostHogResource[] = [];
    let url: string | null = `${apiRoot}/${path}/?limit=100${path === 'insights' ? '&include_dashboards=true' : ''}`;
    while (url) {
      const page: Page<PostHogResource> = await request<Page<PostHogResource>>(url);
      resources.push(...page.results);
      url = page.next;
    }
    return resources;
  };

  const dashboards = await list('dashboards');
  let dashboard = namedResource(dashboards, DASHBOARD_NAME, 'dashboard');
  let dashboardUpdated = false;
  if (!dashboard) {
    dashboard = await request<PostHogResource>(`${apiRoot}/dashboards/`, 'POST', {
      name: DASHBOARD_NAME,
      description: DASHBOARD_DESCRIPTION,
    });
  } else if (dashboard.description !== DASHBOARD_DESCRIPTION) {
    dashboard = await request<PostHogResource>(`${apiRoot}/dashboards/${dashboard.id}/`, 'PATCH', {
      description: DASHBOARD_DESCRIPTION,
    });
    dashboardUpdated = true;
  }

  const insights = await list('insights');
  let created = 0;
  let updated = dashboardUpdated ? 1 : 0;
  let unchanged = 0;
  for (const definition of definitions) {
    let insight = namedResource(insights, definition.name, 'insight');
    if (!insight) {
      insight = await request<PostHogResource>(`${apiRoot}/insights/`, 'POST', {
        name: definition.name,
        description: definition.description,
        query: definition.query,
        dashboards: [dashboard.id],
      });
      insights.push(insight);
      created++;
      continue;
    }

    const dashboardIds = insight.dashboards ?? [];
    const needsUpdate = insight.description !== definition.description
      || !matchesDesired(insight.query, definition.query)
      || !dashboardIds.includes(dashboard.id);
    if (needsUpdate) {
      insight = await request<PostHogResource>(`${apiRoot}/insights/${insight.id}/`, 'PATCH', {
        name: definition.name,
        description: definition.description,
        query: definition.query,
        dashboards: [...new Set([...dashboardIds, dashboard.id])],
      });
      const index = insights.findIndex(existing => existing.id === insight!.id);
      if (index >= 0) insights[index] = insight;
      updated++;
    } else {
      unchanged++;
    }
  }

  return { created, updated, unchanged };
}

async function main() {
  const result = await syncDashboard(readConfig(process.env));
  console.log(`Brick Arena PostHog dashboard ready: ${result.created} insights created, ${result.updated} resources updated, ${result.unchanged} insights unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
