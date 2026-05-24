import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AgentInstance } from '../../shared/types';

// Dark terminal colour scheme
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
};

const TYPE_ICON: Record<string, string> = {
  claude: '◆',
  codex:  '◈',
};

interface Props {
  agent: AgentInstance;
  onClose: () => void;
}

export default function TerminalPanel({ agent, onClose }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>('starting');

  useEffect(() => {
    if (!containerRef.current) return;

    // Create terminal
    const term = new Terminal({
      theme: THEME,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Give the DOM a frame to settle before fitting
    requestAnimationFrame(() => {
      fit.fit();
    });

    termRef.current = term;
    fitRef.current  = fit;

    const { cols, rows } = term;

    // Spawn the PTY
    window.electronAPI.ptyCreate({
      id:      agent.id,
      command: agent.command,
      cwd:     agent.cwd,
      cols,
      rows,
    }).then((result) => {
      if (result.success) {
        setStatus('running');
      } else {
        setStatus('error');
        term.writeln(`\r\n\x1b[31m✗ Failed to start: ${result.error}\x1b[0m`);
      }
    });

    // PTY → terminal
    const unsubData = window.electronAPI.onPtyData(agent.id, (data) => {
      term.write(data);
    });

    // PTY exit
    const unsubExit = window.electronAPI.onPtyExit(agent.id, (code) => {
      setStatus('exited');
      term.writeln(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m`);
    });

    // Terminal → PTY (user keystrokes)
    term.onData((data) => {
      window.electronAPI.ptyWrite(agent.id, data);
    });

    // Resize: watch the container with ResizeObserver
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        window.electronAPI.ptyResize(agent.id, term.cols, term.rows);
      } catch (_e) {}
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      unsubData();
      unsubExit();
      window.electronAPI.ptyKill(agent.id).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  // Only run on mount — agent.id never changes for a given panel
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const accentColor = TYPE_COLOR[agent.type] || '#888';

  return (
    <div className="terminal-panel" style={{ '--accent': accentColor } as React.CSSProperties}>
      {/* Panel header */}
      <div className="panel-header">
        <span className="panel-type-icon" style={{ color: accentColor }}>
          {TYPE_ICON[agent.type] || '▸'}
        </span>
        <span className="panel-name">{agent.name}</span>
        <span className={`panel-status status-${status}`} title={status} />
        <button
          className="panel-close"
          onClick={onClose}
          title="Close this agent"
        >
          ✕
        </button>
      </div>

      {/* xterm.js mounts here */}
      <div ref={containerRef} className="panel-terminal" />
    </div>
  );
}
