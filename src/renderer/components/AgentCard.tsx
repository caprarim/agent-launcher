import React from 'react';
import { AgentConfig } from '../../shared/types';

interface Props {
  type: AgentConfig['type'];
  color: string;
  icon: string;
  config: AgentConfig;
  onChange: (type: AgentConfig['type'], field: 'count' | 'command', value: string | number) => void;
}

const LABEL_MAP: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
};

export default function AgentCard({ type, color, icon, config, onChange }: Props): JSX.Element {
  return (
    <div className="card">
      <div className="card-header">
        <div className="agent-dot" style={{ background: color }} />
        <h2>{icon} {LABEL_MAP[type]}</h2>
        <span className="badge">{config.count} agent{config.count !== 1 ? 's' : ''}</span>
      </div>

      <div className="form-row">
        <div className="form-group" style={{ flex: 'none' }}>
          <label>Count</label>
          <input
            type="number"
            min={0}
            max={10}
            value={config.count}
            onChange={(e) => onChange(type, 'count', Math.max(0, parseInt(e.target.value) || 0))}
          />
        </div>
        <div className="form-group">
          <label>Command</label>
          <input
            type="text"
            value={config.command}
            placeholder={`e.g. ${type}`}
            onChange={(e) => onChange(type, 'command', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
