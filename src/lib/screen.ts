const BOX_CHARS = /[│┃╭╮╰╯─━┏┓┗┛┌┐└┘├┤┬┴┼]/g;

const BUSY_MARKERS = [
  'esc to interrupt',
  'escape to interrupt',
  'ctrl+c to stop',
  'ctrl+c to interrupt',
  'ctrl+b to run in background',
  'tokens ·',
  'interrupt ·',
];

const IDLE_MARKERS = [
  'for shortcuts',
  'bypass permissions on',
  'bypassing permissions',
  'accept edits on',
  'plan mode on',
  'shift+tab to cycle',
];

const ELAPSED_COUNTER = /\(\s*(esc|\d+\s*s\b)/;

const CHOICE_PHRASE = /(do you want|would you like|would you prefer|shall i|should i|proceed\?|continue\?|do you approve|how would you like|which option)/i;

export function screenRows(screen: string): string[] {
  return screen
    .split('\n')
    .map((l) => l.replace(BOX_CHARS, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function bottom(screen: string, rows = 14): string {
  return screenRows(screen).slice(-rows).join(' ').toLowerCase();
}

export function isBusyScreen(screen: string): boolean {
  const flat = bottom(screen, 8);
  if (BUSY_MARKERS.some((m) => flat.includes(m))) return true;
  return /[a-z]+…/.test(flat) && ELAPSED_COUNTER.test(flat);
}

export function isIdleScreen(screen: string): boolean {
  const flat = bottom(screen);
  if (IDLE_MARKERS.some((m) => flat.includes(m))) return true;
  const rows = screenRows(screen);
  const last = rows[rows.length - 1] || '';
  return /^>\s*$/.test(last) || /^>\s\S/.test(last);
}

export function detectAsking(screen: string): boolean {
  const stripped = screenRows(screen);
  if (!stripped.length) return false;

  const hasArrow = /❯/.test(screen);
  const optionRows = stripped.filter((l) => /^❯?\s*\d+[.)]\s+\S/.test(l)).length;
  if (hasArrow && optionRows >= 1) return true;
  if (optionRows >= 2 && stripped.some((l) => CHOICE_PHRASE.test(l))) return true;

  const isIdleHint = (l: string) =>
    /for shortcuts/i.test(l) ||
    /bypass permissions/i.test(l) ||
    /esc to interrupt/i.test(l) ||
    /^>\s*$/.test(l) ||
    /^>\s/.test(l);
  const content = stripped.filter((l) => !isIdleHint(l));
  const last = content[content.length - 1] || '';
  return /\?$/.test(last);
}
