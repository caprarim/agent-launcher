import React, { useState, useCallback } from 'react';
import TerminalPanel from './components/TerminalPanel';
import { AgentInstance, AgentType } from '../shared/types';
import * as os from 'os';

const COMMANDS: Record<AgentType, string> = {
  claude: 'claude --dangerously-skip-permissions',
  codex:  'codex --approval-mode full-auto',
};

// Counter per type so names stay sequential
const counters: Record<AgentType, number> = { claude: 0, codex: 0 };

function gridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  return 3;
}

export default function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentInstance[]>([]);
  const [projectPath, setProjectPath] = useState('');

  const cwd = projectPath.trim() || '.';

  const addAgent = useCallback((type: AgentType) => {
    counters[type] += 1;
    const id   = `${type}-${Date.now()}`;
    const name = `${type}-agent-${counters[type]}`;
    setAgents((prev) => [
      ...prev,
      { id, type, name, command: COMMANDS[type], status: 'starting', cwd },
    ]);
  }, [cwd]);

  const removeAgent = useCallback((id: string) => {
    setAgents((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const removeAll = useCallback(() => {
    setAgents([]);
  }, []);

  const handlePickDir = async () => {
    const dir = await window.electronAPI.pickDirectory();
    if (dir) setProjectPath(dir);
  };

  const cols = gridCols(agents.length);

  return (
    <div className="app">
      {/* ── Top bar ── */}
      <div className="topbar">
        <div className="topbar-left">
          <span className="logo">⚡</span>
          <span className="app-title">Agent Launcher</span>
        </div>

        <div className="topbar-center">
          <div className="path-wrap">
            <span className="path-icon">📁</span>
            <input
              className="path-input"
              type="text"
              placeholder="Project path (default: current dir)"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
            />
            <button className="path-browse" onClick={handlePickDir}>Browse</button>
          </div>
        </div>

        <div className="topbar-right">
          <button className="btn-add btn-claude" onClick={() => addAgent('claude')}>
            <span className="btn-icon">◆</span> Add Claude
          </button>
          <button className="btn-add btn-codex" onClick={() => addAgent('codex')}>
            <span className="btn-icon">◈</span> Add Codex
          </button>
          {agents.length > 0 && (
            <button className="btn-stop-all" onClick={removeAll} title="Kill & close all agents">
              ✕ Stop All
            </button>
          )}
        </div>
      </div>

      {/* ── Main area ── */}
      {agents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">⚡</div>
          <h2>Agent Launcher</h2>
          <p>Add agents to get started. Each one opens as a live terminal below.</p>
          <div className="empty-buttons">
            <button className="btn-add btn-claude lg" onClick={() => addAgent('claude')}>
              <span className="btn-icon">◆</span> Add Claude Agent
            </button>
            <button className="btn-add btn-codex lg" onClick={() => addAgent('codex')}>
              <span className="btn-icon">◈</span> Add Codex Agent
            </button>
          </div>
          <p className="empty-hint">
            Runs <code>claude --dangerously-skip-permissions</code> and <code>codex --approval-mode full-auto</code>
          </p>
        </div>
      ) : (
        <div
          className="terminal-grid"
          style={{ '--grid-cols': cols } as React.CSSProperties}
        >
          {agents.map((agent) => (
            <TerminalPanel
              key={agent.id}
              agent={agent}
              onClose={() => removeAgent(agent.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
