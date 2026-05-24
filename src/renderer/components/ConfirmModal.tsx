import React from 'react';
import { AgentConfig } from '../../shared/types';

const COLOR_MAP: Record<string, string> = {
  codex: '#a855f7',
  claude: '#f97316',
  gemini: '#06b6d4',
};

const ICON_MAP: Record<string, string> = {
  codex: '◈',
  claude: '◆',
  gemini: '◇',
};

interface Props {
  agents: AgentConfig[];
  projectPath: string;
  initialPrompt: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({ agents, projectPath, initialPrompt, onConfirm, onCancel }: Props): JSX.Element {
  const activeAgents = agents.filter((a) => a.count > 0);
  const total = activeAgents.reduce((s, a) => s + a.count, 0);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h2>Confirm Launch</h2>
        <p>You are about to spawn <strong>{total} agent{total !== 1 ? 's' : ''}</strong> in new terminal windows.</p>

        <ul className="modal-summary">
          {activeAgents.map((a) => (
            <li key={a.type}>
              <span style={{ color: COLOR_MAP[a.type], fontSize: 16 }}>{ICON_MAP[a.type]}</span>
              <span><strong style={{ color: '#f0f0f0' }}>{a.count}×</strong> {a.type} — <code style={{ color: '#888', fontSize: 11 }}>{a.command}</code></span>
            </li>
          ))}
        </ul>

        <p><strong style={{ color: '#888', fontSize: 11 }}>DIRECTORY</strong><br />
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#ccc' }}>{projectPath}</span>
        </p>

        {initialPrompt && (
          <p style={{ marginTop: 10 }}>
            <strong style={{ color: '#888', fontSize: 11 }}>INITIAL PROMPT</strong><br />
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#ccc' }}>
              {initialPrompt.length > 120 ? initialPrompt.slice(0, 120) + '…' : initialPrompt}
            </span>
          </p>
        )}

        <div className="modal-actions">
          <button className="btn btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn btn-confirm" onClick={onConfirm}>⚡ Launch</button>
        </div>
      </div>
    </div>
  );
}
