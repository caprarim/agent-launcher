import { contextBridge, ipcRenderer } from 'electron';
import { LaunchConfig, RunningAgent, LogEntry } from '../shared/types';

// Expose safe IPC methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  launchAgents: (config: LaunchConfig) => ipcRenderer.invoke('launch-agents', config),
  stopAllAgents: () => ipcRenderer.invoke('stop-all-agents'),
  getRunningAgents: () => ipcRenderer.invoke('get-running-agents'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),

  onLogEntry: (callback: (entry: LogEntry) => void) => {
    ipcRenderer.on('log-entry', (_event, entry) => callback(entry));
  },
  onAgentUpdate: (callback: (agent: RunningAgent) => void) => {
    ipcRenderer.on('agent-update', (_event, agent) => callback(agent));
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('log-entry');
    ipcRenderer.removeAllListeners('agent-update');
  },
});
