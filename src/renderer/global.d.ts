import { PtyCreateOptions, PtyCreateResult, AgentInstance, AgentType, FsReadDirResult, FsReadFileResult, FsWriteFileResult } from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      ptyCreate: (opts: PtyCreateOptions) => Promise<PtyCreateResult>;
      ptyWrite: (id: string, data: string) => void;
      ptyResize: (id: string, cols: number, rows: number) => void;
      ptyKill: (id: string) => Promise<void>;
      onPtyData: (id: string, cb: (data: string) => void) => () => void;
      onPtyExit: (id: string, cb: (code: number) => void) => () => void;
      pickDirectory: () => Promise<string | null>;
      fsReadDir: (dirPath: string) => Promise<FsReadDirResult>;
      fsReadFile: (filePath: string) => Promise<FsReadFileResult>;
      fsWriteFile: (filePath: string, content: string) => Promise<FsWriteFileResult>;
      fsWatch: (filePath: string) => Promise<void>;
      fsUnwatch: (filePath: string) => Promise<void>;
      onFsChanged: (cb: (filePath: string) => void) => () => void;
      syncAgents: (agents: AgentInstance[]) => void;
      onControlAddAgent: (cb: (requestId: string, type: AgentType) => void) => () => void;
      controlAddAgentResult: (requestId: string, agent: AgentInstance) => void;
      onControlRemoveAgent: (cb: (id: string) => void) => () => void;
      switchAccount: (workspaceId?: string, configDir?: string) => Promise<{ ok: boolean; email?: string; error?: string }>;
      currentAccount: (configDir?: string) => Promise<{ email: string | null }>;
      onAccountSwitched: (cb: (res: { ok: boolean; email?: string; error?: string; reason: string; workspaceId?: string }) => void) => () => void;
      ensureWorkspaceConfig: (workspaceId: string) => Promise<string>;
      getControlPort: () => Promise<number>;
      nameAgentPrompt: (prompt: string) => Promise<string | null>;
      onAgentRename: (cb: (id: string, name: string) => void) => () => void;
      winBuildNumber: number;
      // 'win32' | 'darwin' | 'linux' — the Tauri build reports Rust's os name.
      platform: string;
      defaultProjectPath: string;
      // Electron ships a <webview> tag; WebKitGTK does not, so the browser pane
      // falls back to an iframe on Linux.
      hasWebview: boolean;
    };
  }
}
