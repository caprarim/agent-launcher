import { backend } from './backend';

export const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];
export const ZOOM_DEFAULT = 1;

export type ZoomAction = 'in' | 'out' | 'reset';

export function zoomAction(e: KeyboardEvent): ZoomAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const code = e.code;
  const key = e.key;
  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return 'in';
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return null;
}

export function nextZoom(current: number, action: ZoomAction): number {
  if (action === 'reset') return ZOOM_DEFAULT;
  const near = ZOOM_STEPS.reduce((best, s) =>
    Math.abs(s - current) < Math.abs(best - current) ? s : best, ZOOM_STEPS[0]);
  const i = ZOOM_STEPS.indexOf(near);
  const j = action === 'in' ? i + 1 : i - 1;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, j))];
}

export function applyZoom(factor: number): void {
  const f = Math.max(0.4, Math.min(3, factor || 1));
  void backend.setUiZoom(f).catch(() => {
    (document.documentElement.style as unknown as { zoom: string }).zoom = String(f);
  });
}
