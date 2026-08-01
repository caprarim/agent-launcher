import { useRef, useCallback } from 'react';

interface Box { x: number; y: number; w: number; h: number }

export type DragMode = 'move' | 'resize' | 'resize-r' | 'resize-b';

export function useDragResize(
  ref: React.RefObject<HTMLDivElement | null>,
  box: Box,
  commit: (patch: Partial<Box>) => void,
  minW = 300,
  minH = 180,
) {
  const drag = useRef<{ mode: DragMode; startX: number; startY: number; box: Box } | null>(null);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === 'move') {
      el.style.left = `${Math.max(0, d.box.x + dx)}px`;
      el.style.top = `${Math.max(40, d.box.y + dy)}px`;
      return;
    }
    if (d.mode === 'resize' || d.mode === 'resize-r') {
      el.style.width = `${Math.max(minW, d.box.w + dx)}px`;
    }
    if (d.mode === 'resize' || d.mode === 'resize-b') {
      el.style.height = `${Math.max(minH, d.box.h + dy)}px`;
    }
  }, [ref, minW, minH]);

  const onUp = useCallback(() => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!d || !el) return;
    if (d.mode === 'move') {
      commit({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    } else {
      commit({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) });
    }
  }, [ref, commit, onMove]);

  const startDrag = useCallback((e: React.PointerEvent, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.add('dragging');
    drag.current = { mode, startX: e.clientX, startY: e.clientY, box: { ...box } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [box, onMove, onUp]);

  return startDrag;
}
