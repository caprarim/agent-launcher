export interface AgentConfig {
  type: 'codex' | 'claude' | 'gemini';
  count: number;
  command: string;
}

export interface LaunchConfig {
  projectPath: string;
  initialPrompt: string;
  maxAgents: number;
  agents: AgentConfig[];
}

export interface RunningAgent {
  id: string;
  name: string;
  type: string;
  pid?: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: Date;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warn';
  message: string;
}

export interface LaunchResult {
  success: boolean;
  agents: RunningAgent[];
  logs: LogEntry[];
  error?: string;
}
