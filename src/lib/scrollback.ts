import { Terminal, IDisposable } from '@xterm/xterm';

interface CoreBuffer {
  scrollTop: number;
  scrollBottom: number;
}

interface CoreAccess {
  buffers?: { active?: CoreBuffer };
  _bufferService?: { scroll: (eraseAttr: unknown, isWrapped?: boolean) => void };
  _inputHandler?: {
    _eraseAttrData?: () => unknown;
    _dirtyRowTracker?: { markRangeDirty: (start: number, end: number) => void };
  };
}

export function keepScrollRegionHistory(term: Terminal): IDisposable | null {
  const core = (term as unknown as { _core?: CoreAccess })._core;
  const bufferService = core?._bufferService;
  const inputHandler = core?._inputHandler;
  if (!core || !bufferService || typeof inputHandler?._eraseAttrData !== 'function') return null;

  return term.parser.registerCsiHandler({ final: 'S' }, (params) => {
    if (term.buffer.active.type !== 'normal') return false;
    const buffer = core.buffers?.active;
    if (!buffer || buffer.scrollTop !== 0) return false;
    const eraseAttr = inputHandler._eraseAttrData?.();
    if (!eraseAttr) return false;
    const raw = params[0];
    const asked = typeof raw === 'number' && raw > 0 ? raw : 1;
    const region = buffer.scrollBottom - buffer.scrollTop + 1;
    const count = Math.min(asked, Math.max(region, 1));
    for (let i = 0; i < count; i++) bufferService.scroll(eraseAttr);
    inputHandler._dirtyRowTracker?.markRangeDirty(buffer.scrollTop, buffer.scrollBottom);
    return true;
  });
}
