import type { Player } from '../../engine/src/index';
import { JEV_DEFAULTS, readJevLink } from './key';
import { httpTransport, recordingTransport, type Transport } from './transport';
import { fromResponse, toRequest } from './wire';

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

// Reads the key file once, at construction (see key.ts for the shapes it
// accepts). The key stays in this closure: it is sent as a header and never
// written to a recording. `baseUrl` and `model` override the file and defaults.
export function jevPlayerFromKeyFile(options: { keyFile?: string; baseUrl?: string; model?: string; recordTo?: string; timeoutMs?: number } = {}): Player {
  const keyFile = options.keyFile ?? JEV_DEFAULTS.keyFile;
  const link = readJevLink(keyFile);
  if (!link.key) throw new Error(`Jev player needs a TypeSafe key in ${keyFile} (see README, "Seat a real Jev")`);
  let transport = httpTransport({ baseUrl: options.baseUrl ?? link.baseUrl, apiKey: link.key, timeoutMs: options.timeoutMs });
  if (options.recordTo) transport = recordingTransport(transport, options.recordTo);
  return jevPlayer({ model: options.model ?? link.model, transport });
}
