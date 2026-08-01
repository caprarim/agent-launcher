import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import '@xterm/xterm/css/xterm.css';
import { AgentCard } from '../lib/types';
import { useStore } from '../lib/store';
import { backend, bindTerminal, bindScreen } from '../lib/backend';
import { displayName } from '../lib/names';
import { useDragResize } from './useDragResize';

const TERM_THEME = {
  background: '#161a22',
  foreground: '#e6e9ef',
  cursor: '#f0a35c',
  selectionBackground: '#3a4254',
  black: '#20242e',
  brightBlack: '#5a6272',
};

let lastFocusReclaim = 0;
function reclaimWindowFocus() {
  const now = Date.now();
  if (now - lastFocusReclaim < 400) return;
  lastFocusReclaim = now;
  void backend.focusMain();
}

export default function TerminalCard({ agent, hidden = false }: { agent: AgentCard; hidden?: boolean }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const termHost = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const created = useRef(false);
  const gotData = useRef(false);
  const [active, setActive] = useState(false);
  const activeTimer = useRef<number | undefined>(undefined);

  const updateAgent = useStore((s) => s.updateAgent);
  const removeAgent = useStore((s) => s.removeAgent);
  const relaunchAgent = useStore((s) => s.relaunchAgent);
  const toggleExpand = useStore((s) => s.toggleExpand);
  const toggleMinimize = useStore((s) => s.toggleMinimize);
  const bringToFront = useStore((s) => s.bringToFront);
  const setFocusAgent = useStore((s) => s.setFocusAgent);
  const focused = useStore((s) => s.focusAgentId === agent.id);
  const settings = useStore((s) => s.settings);
  const configDir = useStore((s) => s.workspaces.find((w) => w.id === agent.workspaceId)?.configDir);

  const startDrag = useDragResize(cardRef, agent, (patch) => updateAgent(agent.id, patch));

  const focusHere = () => {
    reclaimWindowFocus();
    bringToFront(agent.id);
    const term = termRef.current;
    if (!term) return;
    term.focus();
    window.setTimeout(() => term.focus(), 0);
  };
  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'resize' | 'resize-r' | 'resize-b') => {
    if (agent.expanded || focused) return;
    bringToFront(agent.id);
    startDrag(e, mode);
  };

  useEffect(() => {
    if (!termHost.current || created.current) return;
    created.current = true;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(termHost.current);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let ptyLive = false;
    let sentCols = 0;
    let sentRows = 0;

    const measure = () => {
      const host = termHost.current;
      if (!host || host.clientWidth < 40 || host.clientHeight < 40) return false;
      try {
        fit.fit();
      } catch (_e) {
        return false;
      }
      return true;
    };

    const syncSize = () => {
      if (disposed) return;
      if (!measure()) return;
      if (!ptyLive) return;
      if (term.cols === sentCols && term.rows === sentRows) return;
      sentCols = term.cols;
      sentRows = term.rows;
      void backend.ptyResize(agent.id, term.cols, term.rows);
    };

    // Dictation tools (Whisperflow, ColdVoice) inject their transcript via a
    // clipboard-write + synthetic Ctrl+V. The webview's navigator.clipboard
    // API is unreliable here (WebView2 can silently deny programmatic reads),
    // so route paste through Tauri's clipboard-manager plugin instead, which
    // reads the OS clipboard directly. preventDefault is load-bearing: without
    // it the browser's native paste event can also fire, double-pasting.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
        e.preventDefault();
        readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });

    const wheelEl = termHost.current;
    const cellHeight = 12 * 1.25;
    let wheelRemainder = 0;
    const onWheel = (ev: WheelEvent) => {
      if (ev.shiftKey) return;
      if (term.buffer.active.type !== 'normal') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const deltaLines =
        ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? ev.deltaY : ev.deltaY / cellHeight;
      wheelRemainder += deltaLines;
      const whole = wheelRemainder > 0 ? Math.floor(wheelRemainder) : Math.ceil(wheelRemainder);
      if (whole !== 0) {
        wheelRemainder -= whole;
        term.scrollLines(whole);
      }
    };
    wheelEl.addEventListener('wheel', onWheel, { capture: true, passive: false });

    const unbindScreen = bindScreen(agent.id, () => {
      const buf = term.buffer.active;
      const end = buf.baseY + term.rows;
      const lines: string[] = [];
      for (let y = Math.max(0, end - 60); y < end; y++) {
        const l = buf.getLine(y);
        if (l) lines.push(l.translateToString(true));
      }
      return lines.join('\n');
    });

    const unbind = bindTerminal(agent.id, (data) => {
      gotData.current = true;
      term.write(data);
      setActive(true);
      window.clearTimeout(activeTimer.current);
      activeTimer.current = window.setTimeout(() => setActive(false), 3500);
    });

    term.onData((d) => {
      if (d.includes('\r') || d.includes('\n')) {
        const cur = useStore.getState().agents.find((a) => a.id === agent.id);
        if (cur && cur.status !== 'starting' && cur.status !== 'exited') {
          updateAgent(agent.id, { status: 'working' });
        }
      }
      void backend.ptyWrite(agent.id, d);
    });

    const command = settings.claudeCommand || 'claude';
    const settleTimers: number[] = [];

    const start = async () => {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts?.ready) await fonts.ready.catch(() => undefined);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (disposed) return;
      measure();

      const res = await backend
        .ptyCreate({
          id: agent.id,
          command,
          cwd: agent.cwd,
          cols: term.cols,
          rows: term.rows,
          workspaceId: agent.workspaceId,
          configDir,
        })
        .catch((e) => ({ success: false, error: String(e), existing: false }));
      if (disposed) return;

      if (res.success) {
        ptyLive = true;
        sentCols = 0;
        sentRows = 0;
        syncSize();
        for (const ms of [120, 400, 1000, 2200]) {
          settleTimers.push(window.setTimeout(syncSize, ms));
        }
        updateAgent(agent.id, { status: 'running' });
        if (res.existing) {
          const buf = await backend.ptyOutput(agent.id, 200000, true).catch(() => '');
          if (buf && !disposed) term.write(buf);
        } else {
          settleTimers.push(
            window.setTimeout(async () => {
              if (gotData.current) return;
              const buf = await backend.ptyOutput(agent.id, 200000, true).catch(() => '');
              if (buf && !gotData.current && !disposed) {
                gotData.current = true;
                term.write(buf);
              }
            }, 1200),
          );
        }
      } else {
        updateAgent(agent.id, { status: 'exited' });
        term.write(`\r\nfailed to start: ${res.error || 'unknown error'}\r\n`);
      }
    };
    void start();

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(termHost.current);

    return () => {
      disposed = true;
      for (const t of settleTimers) window.clearTimeout(t);
      ro.disconnect();
      wheelEl.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      unbindScreen();
      unbind();
      term.dispose();
    };
  }, []);

  const dotClass =
    agent.status === 'exited' ? 'dot danger' :
    agent.status === 'asking' ? 'dot accent pulse' :
    agent.status === 'done' && !active ? 'dot ok' :
    active ? 'dot accent pulse' : 'dot idle';

  const geo: React.CSSProperties = agent.expanded || focused
    ? { zIndex: agent.z }
    : { left: agent.x, top: agent.y, width: agent.w, height: agent.h, zIndex: agent.z };
  if (hidden) geo.display = 'none';

  return (
    <div
      ref={cardRef}
      className={`card${agent.expanded ? ' expanded' : ''}${agent.minimized ? ' minimized' : ''}${focused ? ' focused' : ''}`}
      style={geo}
      onPointerDown={focusHere}
      onClick={focusHere}
    >
      <div className="card-head" onPointerDown={(e) => { if (e.target === e.currentTarget) beginDrag(e, 'move'); }}>
        <span className={dotClass} />
        <span className="card-name" onPointerDown={(e) => beginDrag(e, 'move')}>{displayName(agent.name)}</span>
        {agent.taskLabel && <span className="card-task" onPointerDown={(e) => beginDrag(e, 'move')}>{agent.taskLabel}</span>}
        <span className="card-type" onPointerDown={(e) => beginDrag(e, 'move')}>{agent.type}</span>
        {focused ? (
          <>
            <span className="focus-tag">Focus Mode</span>
            <button
              className="card-btn focus-x"
              title="Exit focus mode and restore the full window"
              onClick={() => setFocusAgent(null)}
            >
              ×
            </button>
          </>
        ) : (
          <>
            <button
              className="card-btn focus-btn"
              title="Focus mode, float this agent on top of every other window"
              onClick={() => setFocusAgent(agent.id)}
            >
              Focus
            </button>
            <button className="card-btn" title="Relaunch agent" onClick={() => relaunchAgent(agent.id)}>⟳</button>
            <button
              className="card-btn"
              title={agent.minimized ? 'Restore' : 'Minimize'}
              onClick={() => toggleMinimize(agent.id)}
            >
              {agent.minimized ? '▢' : '—'}
            </button>
            <button
              className="card-btn"
              title={agent.expanded ? 'Restore' : 'Expand'}
              onClick={() => toggleExpand(agent.id)}
            >
              {agent.expanded ? '⤡' : '⤢'}
            </button>
            <button className="card-btn" title="Close agent" onClick={() => removeAgent(agent.id)}>×</button>
          </>
        )}
      </div>
      <div className="card-body" ref={termHost} style={agent.minimized ? { display: 'none' } : undefined} />
      {agent.minimized && agent.lastLine && (
        <div className="card-lastline" title={agent.lastLine}>{agent.lastLine}</div>
      )}
      {!agent.expanded && !agent.minimized && !focused && (
        <>
          <div className="card-edge-r" onPointerDown={(e) => beginDrag(e, 'resize-r')} />
          <div className="card-edge-b" onPointerDown={(e) => beginDrag(e, 'resize-b')} />
          <div className="card-grip" onPointerDown={(e) => beginDrag(e, 'resize')} />
        </>
      )}
    </div>
  );
}
