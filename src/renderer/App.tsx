import React, { useState, useEffect, useRef, useCallback } from 'react';
import AgentCard from './components/AgentCard';
import LogPanel from './components/LogPanel';
import ConfirmModal from './components/ConfirmModal';
import { AgentConfig, RunningAgent, LogEntry } from '../shared/types';

const MAX_AGENTS = 10;

const defaultAgents: AgentConfig[] = [
  { type: 'codex',  count: 1, command: 'codex' },
  { type: 'claude', count: 1, command: 'claude' },
  { type: 'gemini', count: 1, command: 'gemini' },
];

export default function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentConfig[]>(defaultAgents);
  const [projectPath, setProjectPath] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runningAgents, setRunningAgents] = useState<RunningAgent[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const electronAPI = (window as any).electronAPI;

  // Subscribe to IPC events from main process
  useEffect(() => {
    electronAPI.onLogEntry((entry: LogEntry) => {
      setLogs((prev) => [...prev, entry]);
    });
    electronAPI.onAgentUpdate((agent: RunningAgent) => {
      setRunningAgents((prev) => {
        const idx = prev.findIndex((a) => a.id === agent.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = agent;
          return next;
        }
        return [...prev, agent];
      });
    });
    return () => electronAPI.removeAllListeners();
  }, []);

  const totalCount = agents.reduce((sum, a) => sum + a.count, 0);

  const updateAgent = useCallback((type: AgentConfig['type'], field: 'count' | 'command', value: string | number) => {
    setAgents((prev) => prev.map((a) => a.type === type ? { ...a, [field]: value } : a));
    setErrorMsg('');
  }, []);

  const handlePickDirectory = async () => {
    const dir = await electronAPI.pickDirectory();
    if (dir) setProjectPath(dir);
  };

  const handleLaunchClick = () => {
    setErrorMsg('');
    // Validation
    if (totalCount === 0) {
      setErrorMsg('Set at least one agent count greater than 0.');
      return;
    }
    if (totalCount > MAX_AGENTS) {
      setErrorMsg(`Total agents (${totalCount}) exceeds max limit of ${MAX_AGENTS}.`);
      return;
    }
    const emptyCmd = agents.find((a) => a.count > 0 && !a.command.trim());
    if (emptyCmd) {
      setErrorMsg(`Command for ${emptyCmd.type} is empty.`);
      return;
    }
    setShowConfirm(true);
  };

  const handleConfirmLaunch = async () => {
    setShowConfirm(false);
    setLaunching(true);
    setErrorMsg('');

    try {
      const result = await electronAPI.launchAgents({
        projectPath: projectPath.trim(),
        initialPrompt: initialPrompt.trim(),
        maxAgents: MAX_AGENTS,
        agents: agents.filter((a) => a.count > 0),
      });

      if (!result.success && result.error) {
        setErrorMsg(result.error);
      }
      // Merge new agents into state
      if (result.agents && result.agents.length > 0) {
        setRunningAgents((prev) => {
          const map = new Map(prev.map((a) => [a.id, a]));
          result.agents.forEach((a: RunningAgent) => map.set(a.id, a));
          return Array.from(map.values());
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Launch failed: ${msg}`);
    } finally {
      setLaunching(false);
    }
  };

  const handleStopAll = async () => {
    try {
      await electronAPI.stopAllAgents();
      setRunningAgents((prev) => prev.map((a) => ({ ...a, status: 'stopped' as const })));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Stop failed: ${msg}`);
    }
  };

  const hasRunning = runningAgents.some((a) => a.status === 'running' || a.status === 'starting');

  return (
    <div className="app">
      {/* Title bar */}
      <div className="titlebar">
        <span className="titlebar-title">⚡ Agent Launcher</span>
      </div>

      <div className="main-content">
        {/* Left: controls */}
        <div className="left-panel">
          <div className="app-header">
            <div className="app-header-icon">⚡</div>
            <div className="app-header-text">
              <h1>Agent Launcher</h1>
              <p>Spawn AI coding agents with one click</p>
            </div>
          </div>

          {/* Agent cards */}
          <AgentCard
            type="codex"
            color="#a855f7"
            icon="◈"
            config={agents.find((a) => a.type === 'codex')!}
            onChange={updateAgent}
          />
          <AgentCard
            type="claude"
            color="#f97316"
            icon="◆"
            config={agents.find((a) => a.type === 'claude')!}
            onChange={updateAgent}
          />
          <AgentCard
            type="gemini"
            color="#06b6d4"
            icon="◇"
            config={agents.find((a) => a.type === 'gemini')!}
            onChange={updateAgent}
          />

          {/* Project path */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 14 }}>📁</span>
              <h2>Project Path</h2>
            </div>
            <div className="path-row">
              <input
                type="text"
                placeholder="Leave empty to use current directory"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
              />
              <button className="path-btn" onClick={handlePickDirectory}>Browse</button>
            </div>
          </div>

          {/* Initial prompt */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 14 }}>💬</span>
              <h2>Initial Prompt</h2>
            </div>
            <textarea
              placeholder="Optional: passed as an argument to each agent command"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              rows={3}
            />
          </div>

          {/* Error */}
          {errorMsg && (
            <div className="error-bar">
              <span>⚠</span> {errorMsg}
            </div>
          )}

          {/* Max limit */}
          <div className="max-row">
            <span className="max-badge">
              Total: <span>{totalCount}</span> / {MAX_AGENTS} max
            </span>
          </div>

          {/* Actions */}
          <button
            className="btn btn-launch"
            onClick={handleLaunchClick}
            disabled={launching || totalCount === 0}
          >
            {launching ? '⏳ Launching...' : `⚡ Launch ${totalCount > 0 ? totalCount : ''} Agent${totalCount !== 1 ? 's' : ''}`}
          </button>

          <button
            className="btn btn-stop"
            onClick={handleStopAll}
            disabled={!hasRunning}
          >
            ⛔ Stop All Agents
          </button>
        </div>

        {/* Right: logs + agent status */}
        <div className="right-panel">
          {/* Active agents */}
          {runningAgents.length > 0 && (
            <div className="agents-grid">
              {runningAgents.map((agent) => (
                <div key={agent.id} className={`agent-chip chip-${agent.status}`}>
                  <div className="agent-chip-dot" />
                  <span className="chip-name">{agent.name}</span>
                  {agent.pid && <span className="chip-pid">PID {agent.pid}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Log panel */}
          <LogPanel logs={logs} onClear={() => setLogs([])} />
        </div>
      </div>

      {/* Confirmation modal */}
      {showConfirm && (
        <ConfirmModal
          agents={agents}
          projectPath={projectPath || '(current directory)'}
          initialPrompt={initialPrompt}
          onConfirm={handleConfirmLaunch}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
