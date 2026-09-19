import type { Player } from '../../engine/src/index';
import { httpTransport, recordingTransport, type Transport } from './transport';
import { fromResponse, toRequest } from './wire';

export const jevEnv = ['JEV_BASE_URL', 'JEV_MODEL', 'JEV_API_KEY'] as const;

export function jevPlayer(options: { model: string; transport: Transport; name?: string }): Player {
  return {
    name: options.name ?? `Jev (${options.model})`,
    decide: async ask => {
      const start = performance.now();
      const response = await options.transport(toRequest(ask, options.model));
      return { decision: fromResponse(ask, response), ms: Math.round(performance.now() - start) };
    },
  };
}

// Reads endpoint, model and key once, at construction. The key stays in this
// closure: it is sent as a header and never written to a recording.
export function jevPlayerFromEnv(env: Record<string, string | undefined> = process.env, options: { recordTo?: string; timeoutMs?: number } = {}): Player {
  const missing = jevEnv.filter(name => !env[name]);
  if (missing.length) throw new Error(`Jev player needs ${missing.join(', ')} in the environment (see README, "Seat a real Jev")`);
  let transport = httpTransport({ baseUrl: env.JEV_BASE_URL!, apiKey: env.JEV_API_KEY!, timeoutMs: options.timeoutMs });
  if (options.recordTo) transport = recordingTransport(transport, options.recordTo);
  return jevPlayer({ model: env.JEV_MODEL!, transport });
}
