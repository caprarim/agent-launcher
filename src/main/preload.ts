import { contextBridge, ipcRenderer } from 'electron';
import { PtyCreateOptions, PtyCreateResult, AgentInstance, AgentType, FsReadDirResult, FsReadFileResult, FsWriteFileResult } from '../shared/types';

const winBuildNumber = process.platform === 'win32'
  ? parseInt((process.getSystemVersion?.() ?? '0.0.0').split('.')[2] || '0', 10)
  : 0;

const dataCallbacks = new Map<string, (data: string) => void>();
const exitCallbacks = new Map<string, (code: number) => void>();
const fsChangeCallbacks = new Set<(filePath: string) => void>();

ipcRenderer.on('pty:data', (_event, { id, data }: { id: string; data: string }) => {
  dataCallbacks.get(id)?.(data);
});
ipcRenderer.on('pty:exit', (_event, { id, exitCode }: { id: string; exitCode: number }) => {
  exitCallbacks.get(id)?.(exitCode);
});
ipcRenderer.on('fs:changed', (_event, filePath: string) => {
  fsChangeCallbacks.forEach((cb) => cb(filePath));
});

contextBridge.exposeInMainWorld('electronAPI', {
  // PTY lifecycle
  ptyCreate: (opts: PtyCreateOptions): Promise<PtyCreateResult> =>
    ipcRenderer.invoke('pty:create', opts),

  ptyWrite: (id: string, data: string): void =>
    ipcRenderer.send('pty:write', { id, data }),

  ptyResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),

  ptyKill: (id: string): Promise<void> =>
    ipcRenderer.invoke('pty:kill', id),

  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    dataCallbacks.set(id, cb);
    return () => dataCallbacks.delete(id);
  },

  onPtyExit: (id: string, cb: (code: number) => void): (() => void) => {
    exitCallbacks.set(id, cb);
    return () => exitCallbacks.delete(id);
  },

  // Directory picker
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('pick-directory'),

  // File system
  fsReadDir: (dirPath: string): Promise<FsReadDirResult> =>
    ipcRenderer.invoke('fs:readdir', dirPath),

  fsReadFile: (filePath: string): Promise<FsReadFileResult> =>
    ipcRenderer.invoke('fs:readfile', filePath),

  fsWriteFile: (filePath: string, content: string): Promise<FsWriteFileResult> =>
    ipcRenderer.invoke('fs:writefile', filePath, content),

  fsWatch: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('fs:watch', filePath),

  fsUnwatch: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('fs:unwatch', filePath),

  onFsChanged: (cb: (filePath: string) => void): (() => void) => {
    fsChangeCallbacks.add(cb);
    return () => fsChangeCallbacks.delete(cb);
  },

  // Control API bridge
  syncAgents: (agents: AgentInstance[]): void =>
    ipcRenderer.send('control:sync-agents', agents),

  onControlAddAgent: (cb: (requestId: string, type: AgentType) => void): (() => void) => {
    const handler = (_e: unknown, { requestId, type }: { requestId: string; type: AgentType }) =>
      cb(requestId, type);
    ipcRenderer.on('control:add-agent', handler);
    return () => ipcRenderer.removeListener('control:add-agent', handler);
  },

  controlAddAgentResult: (requestId: string, agent: AgentInstance): void =>
    ipcRenderer.send('control:add-agent-result', { requestId, agent }),

  onControlRemoveAgent: (cb: (id: string) => void): (() => void) => {
    const handler = (_e: unknown, { id }: { id: string }) => cb(id);
    ipcRenderer.on('control:remove-agent', handler);
    return () => ipcRenderer.removeListener('control:remove-agent', handler);
  },

  // Claude account switching
  switchAccount: (workspaceId?: string, configDir?: string): Promise<{ ok: boolean; email?: string; error?: string }> =>
    ipcRenderer.invoke('account:switch', { workspaceId, configDir }),

  currentAccount: (configDir?: string): Promise<{ email: string | null }> =>
    ipcRenderer.invoke('account:current', configDir),

  onAccountSwitched: (cb: (res: { ok: boolean; email?: string; error?: string; reason: string; workspaceId?: string }) => void): (() => void) => {
    const handler = (_e: unknown, res: { ok: boolean; email?: string; error?: string; reason: string; workspaceId?: string }) => cb(res);
    ipcRenderer.on('account:switched', handler);
    return () => ipcRenderer.removeListener('account:switched', handler);
  },

  ensureWorkspaceConfig: (workspaceId: string): Promise<string> =>
    ipcRenderer.invoke('workspace:ensure-config', workspaceId),

  getControlPort: (): Promise<number> =>
    ipcRenderer.invoke('control:port'),

  // Agent tab naming
  nameAgentPrompt: (prompt: string): Promise<string | null> =>
    ipcRenderer.invoke('ai:name-agent', prompt),

  // Names computed in the main process for agents driven over the control API
  // (they never type, so the renderer never sees a prompt for them).
  // An empty name means "reset this tab to its default".
  onAgentRename: (cb: (id: string, name: string) => void): (() => void) => {
    const handler = (_e: unknown, { id, name }: { id: string; name: string }) => cb(id, name);
    ipcRenderer.on('agent:rename', handler);
    return () => ipcRenderer.removeListener('agent:rename', handler);
  },

  winBuildNumber,
  platform: process.platform,
  defaultProjectPath: process.platform === 'win32' ? 'C:\\dev' : (process.env.HOME || ''),
  hasWebview: true,
});
