export type ChimeKind = 'done' | 'asking';

export interface ChimeNote {
  freq: number;
  at: number;
  dur: number;
  gain: number;
}

const DONE: ChimeNote[] = [
  { freq: 880.0, at: 0, dur: 0.17, gain: 0.22 },
  { freq: 1318.51, at: 0.105, dur: 0.34, gain: 0.17 },
];

const ASKING: ChimeNote[] = [
  { freq: 1318.51, at: 0, dur: 0.13, gain: 0.2 },
  { freq: 987.77, at: 0.125, dur: 0.13, gain: 0.2 },
  { freq: 1318.51, at: 0.25, dur: 0.34, gain: 0.17 },
];

export const CHIME_ATTACK = 0.012;

export function notesFor(kind: ChimeKind): ChimeNote[] {
  return kind === 'asking' ? ASKING : DONE;
}

export function chimeLength(kind: ChimeKind): number {
  return notesFor(kind).reduce((end, n) => Math.max(end, n.at + n.dur), 0);
}

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function armChime(): void {
  const ac = audio();
  if (ac && ac.state === 'suspended') void ac.resume();
}

export function playChime(kind: ChimeKind): void {
  const ac = audio();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume();
  const start = ac.currentTime + 0.02;
  for (const n of notesFor(kind)) {
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    const t = start + n.at;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(n.gain, t + CHIME_ATTACK);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(amp);
    amp.connect(ac.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}
