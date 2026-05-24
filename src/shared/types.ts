export type AgentType = 'claude' | 'codex';

export interface AgentInstance {
  id: string;
  type: AgentType;
  name: string;
  command: string;
  status: 'starting' | 'running' | 'exited' | 'error';
  pid?: number;
  cwd: string;
}

export interface PtyCreateOptions {
  id: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyCreateResult {
  success: boolean;
  pid?: number;
  error?: string;
}
