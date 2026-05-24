import { contextBridge, ipcRenderer } from 'electron';
import { PtyCreateOptions, PtyCreateResult } from '../shared/types';

// Per-agent callbacks registered from TerminalPanel components
const dataCallbacks = new Map<string, (data: string) => void>();
const exitCallbacks = new Map<string, (code: number) => void>();

// Single global IPC listeners that dispatch by id
ipcRenderer.on('pty:data', (_event, { id, data }: { id: string; data: string }) => {
  dataCallbacks.get(id)?.(data);
});
ipcRenderer.on('pty:exit', (_event, { id, exitCode }: { id: string; exitCode: number }) => {
  exitCallbacks.get(id)?.(exitCode);
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

  // Subscribe to output from a specific PTY; returns unsubscribe fn
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
});
