export type AgentType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'grok';

export interface WorkspaceInfo {
  id: string;
  name: string;
  configDir?: string;
}

export interface AgentInstance {
  id: string;
  type: AgentType;
  name: string;
  command: string;
  status: 'starting' | 'running' | 'exited' | 'error';
  pid?: number;
  cwd: string;
  workspaceId?: string;
}

export interface PtyCreateOptions {
  id: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  workspaceId?: string;
  configDir?: string;
}

export interface PtyCreateResult {
  success: boolean;
  pid?: number;
  error?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsReadDirResult {
  entries: FsEntry[];
  error?: string;
}

export interface FsReadFileResult {
  content: string;
  error?: string;
}

export interface FsWriteFileResult {
  success: boolean;
  error?: string;
}
