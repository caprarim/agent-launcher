import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import '@xterm/xterm/css/xterm.css';
import { AGENT_LABELS, AgentCard, AgentType, agentCommand } from '../lib/types';
import { useStore } from '../lib/store';
import { backend, bindTerminal, bindScreen } from '../lib/backend';
import { primeAndTask } from '../lib/orchestrator';
import { keepScrollRegionHistory } from '../lib/scrollback';
import { displayName } from '../lib/names';
import { useDragResize } from './useDragResize';
import UsageBar from './UsageBar';

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

function replacementPrompt(agent: AgentCard, nextType: AgentType, transcript: string): string {
  const context = transcript.replace(/\u0000/g, '').trim().slice(-12000);
  const task = agent.taskLabel.trim();
  return [
    `You are replacing a ${AGENT_LABELS[agent.type]} agent with ${AGENT_LABELS[nextType]} in the same project folder.`,
    'Continue the work it was doing. Inspect the current worktree first, preserve its changes, do not repeat completed work, and proceed from the latest state.',
    task ? `Current task: ${task}.` : '',
    context ? `Outgoing terminal context:\n${context}` : 'No terminal transcript was available, so infer the active work from the current worktree.',
  ].filter(Boolean).join('\n\n');
}

export default function TerminalCard({ agent, hidden = false }: { agent: AgentCard; hidden?: boolean }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const termHost = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const created = useRef(false);
  const gotData = useRef(false);
  const [active, setActive] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [statusUsage, setStatusUsage] = useState(false);
  const statusUsageRef = useRef(false);
  const typedLine = useRef('');
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

  const ensureFocus = (tries = 5) => {
    const term = termRef.current;
    if (!term) return;
    term.focus();
    const el = document.activeElement as HTMLElement | null;
    const landed = !!el
      && el.classList.contains('xterm-helper-textarea')
      && !!cardRef.current?.contains(el);
    if (landed || tries <= 0) return;
    window.requestAnimationFrame(() => ensureFocus(tries - 1));
  };

  const focusHere = () => {
    reclaimWindowFocus();
    bringToFront(agent.id);
    ensureFocus();
  };
  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'resize' | 'resize-r' | 'resize-b') => {
    if (agent.expanded || focused) return;
    bringToFront(agent.id);
    startDrag(e, mode);
  };

  const replaceAgent = async () => {
    if (replacing) return;
    setReplacing(true);
    const current = useStore.getState().agents.find((a) => a.id === agent.id);
    if (!current) {
      setReplacing(false);
      return;
    }
    const nextType: AgentType = current.type === 'claude' ? 'codex' : 'claude';
    const transcript = await backend.ptyOutput(current.id, 16000).catch(() => current.summary || '');
    const prompt = replacementPrompt(current, nextType, transcript);
    await backend.ptyKill(current.id).catch(() => {});
    const store = useStore.getState();
    const latest = store.agents.find((a) => a.id === current.id);
    if (!latest) return;
    const workspace = store.workspaces.find((w) => w.id === latest.workspaceId);
    store.updateAgent(latest.id, {
      type: nextType,
      epoch: latest.epoch + 1,
      status: 'starting',
      lastLine: '',
      summary: '',
      accountId: workspace?.accountId || 'default',
    });
    primeAndTask(latest.id, prompt);
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
    const scrollShim = keepScrollRegionHistory(term);

    let disposed = false;
    let deadNotified = false;
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

    const wheelEl = termHost.current;

    let nativePasteAt = 0;
    const onNativePaste = (ev: ClipboardEvent) => {
      if (ev.clipboardData?.getData('text/plain')) nativePasteAt = Date.now();
    };
    wheelEl.addEventListener('paste', onNativePaste as EventListener, true);

    const pasteFallback = async (pending: Promise<string | null>, firedAt: number) => {
      const text = await pending;
      if (nativePasteAt >= firedAt) return;
      if (text) {
        term.paste(text);
        return;
      }
      const path = await backend.clipboardImageFile().catch(() => null);
      if (nativePasteAt >= firedAt) return;
      if (path) term.paste(`${path} `);
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return true;
      const isC = e.code === 'KeyC' || (e.key || '').toLowerCase() === 'c';
      if (isC && e.shiftKey) {
        const sel = term.getSelection();
        if (sel) void writeText(sel).catch(() => {});
        return false;
      }
      const isV = e.code === 'KeyV' || (e.key || '').toLowerCase() === 'v';
      if (!isV) return true;
      const firedAt = Date.now();
      const pending = readText().catch(() => null);
      window.setTimeout(() => {
        if (nativePasteAt >= firedAt) return;
        void pasteFallback(pending, firedAt);
      }, 40);
      return false;
    });

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

    const showStatusUsage = () => {
      if (statusUsageRef.current) return;
      statusUsageRef.current = true;
      setStatusUsage(true);
    };

    const trackTyping = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          if (typedLine.current.trim().toLowerCase() === '/status') showStatusUsage();
          typedLine.current = '';
        } else if (ch === '\x7f' || ch === '\b') {
          typedLine.current = typedLine.current.slice(0, -1);
        } else if (ch === '\x1b' || ch === '\x03' || ch === '\x15') {
          typedLine.current = '';
        } else if (ch >= ' ') {
          typedLine.current += ch;
        }
      }
    };

    const unbind = bindTerminal(agent.id, (data) => {
      gotData.current = true;
      if (agent.type === 'codex' && !statusUsageRef.current && data.includes('5h limit')) {
        showStatusUsage();
      }
      term.write(data);
      setActive(true);
      window.clearTimeout(activeTimer.current);
      activeTimer.current = window.setTimeout(() => setActive(false), 3500);
    });

    term.onData((d) => {
      if (agent.type === 'codex' && !statusUsageRef.current) trackTyping(d);
      if (d.includes('\r') || d.includes('\n')) {
        const cur = useStore.getState().agents.find((a) => a.id === agent.id);
        if (cur && cur.status !== 'starting' && cur.status !== 'exited') {
          updateAgent(agent.id, { status: 'working' });
        }
      }
      void backend.ptyWrite(agent.id, d).then((queued) => {
        if (queued !== false || deadNotified) return;
        deadNotified = true;
        updateAgent(agent.id, { status: 'exited' });
        term.write('\r\n\x1b[33mthis terminal is gone, press the relaunch button to start it again\x1b[0m\r\n');
      }).catch(() => {});
    });

    const command = agentCommand(settings, agent.type);
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
          configDir: agent.type === 'claude' ? configDir : undefined,
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
      wheelEl.removeEventListener('paste', onNativePaste as EventListener, true);
      unbindScreen();
      unbind();
      scrollShim?.dispose();
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
      data-agent-id={agent.id}
      className={`card card-${agent.type}${agent.expanded ? ' expanded' : ''}${agent.minimized ? ' minimized' : ''}${focused ? ' focused' : ''}`}
      style={geo}
      onPointerDown={focusHere}
      onClick={focusHere}
    >
      <div className="card-head" onPointerDown={(e) => { if (e.target === e.currentTarget) beginDrag(e, 'move'); }}>
        <span className={dotClass} />
        <span className="card-name" onPointerDown={(e) => beginDrag(e, 'move')}>{displayName(agent.name)}</span>
        {agent.taskLabel && <span className="card-task" onPointerDown={(e) => beginDrag(e, 'move')}>{agent.taskLabel}</span>}
        <span className="card-type" onPointerDown={(e) => beginDrag(e, 'move')}>{agent.type}</span>
        <button
          className="card-btn replace-btn"
          title={`Replace with ${AGENT_LABELS[agent.type === 'claude' ? 'codex' : 'claude']} and continue the current work`}
          onClick={() => void replaceAgent()}
          disabled={replacing}
        >
          Replace
        </button>
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
      {!agent.minimized && agent.type === 'claude' && <UsageBar agentId={agent.id} configDir={configDir} />}
      {!agent.minimized && agent.type === 'codex' && statusUsage && <UsageBar agentId={agent.id} kind="codex" />}
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
