// The stand-in's whole rule, shared by `pnpm jev:stub` and `pnpm fair` so the
// measured stand-in and the one you play against choose alike: `landing` for a
// target ask, otherwise the first key offered.
export function standInChoice(keys: string[]): string {
  return keys.includes('landing') ? 'landing' : keys[0] ?? 'ready';
}
