import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AgentInstance } from '../../shared/types';

const THEME = {
  background:          '#0a0a0a',
  foreground:          '#d4d4d4',
  cursor:              '#22c55e',
  cursorAccent:        '#0a0a0a',
  selectionBackground: 'rgba(34,197,94,0.2)',
  black:               '#1a1a1a',
  red:                 '#f87171',
  green:               '#22c55e',
  yellow:              '#fbbf24',
  blue:                '#60a5fa',
  magenta:             '#c084fc',
  cyan:                '#22d3ee',
  white:               '#d4d4d4',
  brightBlack:         '#4b4b4b',
  brightRed:           '#fca5a5',
  brightGreen:         '#86efac',
  brightYellow:        '#fde68a',
  brightBlue:          '#93c5fd',
  brightMagenta:       '#d8b4fe',
  brightCyan:          '#67e8f9',
  brightWhite:         '#ffffff',
};

const TYPE_COLOR: Record<string, string> = {
  claude: '#f97316',
  codex:  '#a855f7',
  gemini: '#4285f4',
  cursor: '#00c8c8',
  grok:   '#e5e5e5',
};

const MIN_PANEL_WIDTH = 280;
const MIN_PANEL_HEIGHT = 160;

interface Props {
  agent: AgentInstance;
  configDir?: string;
  onClose: () => void;
  onPrompt: (id: string, line: string) => void;
  onRename: (id: string, name: string) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  width?: number;
  height?: number;
  onResize?: (width: number, height: number) => void;
}

export default function TerminalPanel({
  agent,
  configDir,
  onClose,
  onPrompt,
  onRename,
  isFullscreen = false,
  onToggleFullscreen,
  width,
  height,
  onResize,
}: Props): JSX.Element {
  const containerRef  = useRef<HTMLDivElement>(null);
  const termRef       = useRef<Terminal | null>(null);
  const fitRef        = useRef<FitAddon | null>(null);
  const lastSizeRef   = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineBufRef    = useRef('');
  const onPromptRef   = useRef(onPrompt);
  onPromptRef.current = onPrompt;
  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>('starting');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!containerRef.current) return;

    // The main process spawns PTYs with node-pty's bundled modern conpty.dll
    // (Windows Terminal build), not the OS conhost — report a build number
    // >= 21376 so xterm skips its legacy-conhost heuristics.
    const buildNumber = Math.max(window.electronAPI.winBuildNumber || 19045, 22621);
    // conpty is a Windows concept. On Linux the PTY is a real pty and telling
    // xterm otherwise only invites Windows-only line-wrapping heuristics.
    const isWindows = window.electronAPI.platform !== 'linux' && window.electronAPI.platform !== 'darwin';
    const term = new Terminal({
      theme: THEME,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 10000,
      ...(isWindows ? { windowsPty: { backend: 'conpty' as const, buildNumber } } : {}),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    const helperTA = containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (helperTA) {
      helperTA.style.left    = '0';
      helperTA.style.top     = '0';
      helperTA.style.width   = '100%';
      helperTA.style.height  = '100%';
      helperTA.style.opacity = '0.01';
      helperTA.style.zIndex  = '0';
    }

    // Claude Code (and other TUI agents) enable mouse reporting, which makes
    // xterm forward wheel events to the app instead of scrolling the viewport
    // — the pane then feels "unscrollable". Scroll the scrollback ourselves in
    // the capture phase. Shift+wheel still reaches the app; alt-buffer apps
    // (full-screen TUIs) keep native handling since they have no scrollback.
    const wheelEl = containerRef.current;
    let wheelRemainder = 0;
    const onWheel = (ev: WheelEvent) => {
      if (ev.shiftKey) return;
      if (term.buffer.active.type !== 'normal') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const cellHeight = 13 * 1.2; // fontSize * lineHeight
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

    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
        // preventDefault is load-bearing: without it the browser still fires its
        // native paste event into xterm's textarea, so the text arrived TWICE
        // (once via term.paste here, once via xterm's own paste handler). With
        // bracketed paste on (Claude Code) the chunks contain \x1b, which
        // defeated the old duplicate-chunk guard in onData.
        e.preventDefault();
        navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });

    termRef.current = term;
    fitRef.current  = fit;

    document.fonts.ready.then(() => {
      fit.fit();
      const { cols, rows } = term;
      lastSizeRef.current = { cols, rows };

      window.electronAPI.ptyCreate({
        id:          agent.id,
        command:     agent.command,
        cwd:         agent.cwd,
        cols,
        rows,
        workspaceId: agent.workspaceId,
        configDir,
      }).then((result) => {
        if (result.success) {
          setStatus('running');
        } else {
          setStatus('error');
          term.writeln(`\r\n\x1b[31m✗ Failed to start: ${result.error}\x1b[0m`);
        }
      });
    });

    const unsubData = window.electronAPI.onPtyData(agent.id, (data) => {
      term.write(data);
    });

    const unsubExit = window.electronAPI.onPtyExit(agent.id, (code) => {
      setStatus('exited');
      term.writeln(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m`);
    });

    // Reconstruct the line the user submits so the panel can auto-name itself.
    // We watch raw keystrokes (independent of what the TUI echoes): printable
    // chars accumulate, Backspace deletes, Ctrl-C/U/W clear, and Enter finalizes.
    // Escape sequences (arrow keys, bracketed-paste markers) are stripped first.
    const feedNamer = (chunk: string) => {
      const cleaned = chunk
        .replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '')
        .replace(/\x1b[ #%()*+].?/g, '')
        .replace(/\x1b./g, '');
      for (const ch of cleaned) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          const line = lineBufRef.current.trim();
          lineBufRef.current = '';
          if (line) onPromptRef.current(agent.id, line);
        } else if (ch === '\x7f' || ch === '\x08') {
          lineBufRef.current = lineBufRef.current.slice(0, -1);
        } else if (code === 0x03 || code === 0x15 || code === 0x17) {
          lineBufRef.current = ''; // Ctrl-C / Ctrl-U / Ctrl-W
        } else if (code >= 0x20) {
          lineBufRef.current += ch;
        }
      }
    };

    term.onData((data) => {
      feedNamer(data);
      window.electronAPI.ptyWrite(agent.id, data);
    });

    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        try {
          fit.fit();
          const { cols, rows } = term;
          if (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows) {
            lastSizeRef.current = { cols, rows };
            window.electronAPI.ptyResize(agent.id, cols, rows);
          }
        } catch (_e) {}
      }, 80);
    });
    observer.observe(containerRef.current);

    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      wheelEl.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      observer.disconnect();
      unsubData();
      unsubExit();
      window.electronAPI.ptyKill(agent.id).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const accentColor = TYPE_COLOR[agent.type] || '#888';

  const startEdit = () => { setDraft(agent.name); setEditing(true); };
  const commitEdit = () => {
    if (editing) { onRename(agent.id, draft); setEditing(false); }
  };

  const resizingRef = useRef<{ axis: 'x' | 'y' | 'xy'; startX: number; startY: number; startW: number; startH: number } | null>(null);

  const startResize = (axis: 'x' | 'y' | 'xy') => (e: React.MouseEvent) => {
    if (!onResize) return;
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { axis, startX: e.clientX, startY: e.clientY, startW: width ?? MIN_PANEL_WIDTH, startH: height ?? MIN_PANEL_HEIGHT };
    const onMove = (ev: MouseEvent) => {
      const r = resizingRef.current;
      if (!r) return;
      const newW = r.axis === 'y' ? r.startW : Math.max(MIN_PANEL_WIDTH, r.startW + (ev.clientX - r.startX));
      const newH = r.axis === 'x' ? r.startH : Math.max(MIN_PANEL_HEIGHT, r.startH + (ev.clientY - r.startY));
      onResize(newW, newH);
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const panelStyle: React.CSSProperties = { '--accent': accentColor } as React.CSSProperties;
  if (!isFullscreen && width && height) {
    panelStyle.width = width;
    panelStyle.height = height;
  }

  return (
    <div
      className={`terminal-panel${isFullscreen ? ' terminal-panel--fullscreen' : ''}`}
      style={panelStyle}
    >
      <div className="panel-header">
        <span className="panel-type-dot" style={{ background: accentColor }} />
        {editing ? (
          <input
            className="panel-name-input"
            value={draft}
            autoFocus
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              else if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span
            className="panel-name"
            title="Double-click to rename"
            onDoubleClick={startEdit}
          >{agent.name}</span>
        )}
        <span className={`panel-status status-${status}`} title={status} />
        {onToggleFullscreen && (
          <button
            className="panel-fullscreen"
            title={isFullscreen ? 'Minimize' : 'Full screen'}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
        )}
        <button className="panel-close" onClick={onClose}>Close</button>
      </div>
      <div ref={containerRef} className="panel-terminal" />
      {!isFullscreen && onResize && (
        <>
          <div className="panel-resize-handle panel-resize-handle--e" onMouseDown={startResize('x')} />
          <div className="panel-resize-handle panel-resize-handle--s" onMouseDown={startResize('y')} />
          <div className="panel-resize-handle panel-resize-handle--se" onMouseDown={startResize('xy')} />
        </>
      )}
    </div>
  );
}
