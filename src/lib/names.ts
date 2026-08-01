export const NAME_POOL = [
  'codel', 'marshall', 'gemma', 'rocky', 'chase', 'nova', 'juno', 'pixel',
  'sage', 'onyx', 'drift', 'echo', 'atlas', 'ivy', 'cosmo', 'fern',
  'indigo', 'ridge', 'willow', 'ember',
  'aspen', 'birch', 'cedar', 'delta', 'flint', 'harbor', 'jasper', 'koda',
  'lumen', 'maple', 'nimbus', 'orbit', 'quartz', 'raven', 'slate', 'tundra',
  'vesper', 'wren', 'zephyr', 'halo',
];

export const MAX_AGENTS = 26;

export function pickNames(count: number, taken: string[]): string[] {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const fresh = NAME_POOL.filter((n) => !used.has(n));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (fresh.length > 0) {
      const idx = Math.floor(Math.random() * fresh.length);
      out.push(fresh.splice(idx, 1)[0]);
    } else {
      out.push(`agent${taken.length + i + 1}`);
    }
  }
  return out;
}

export function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
