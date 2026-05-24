import { LaunchConfig, RunningAgent, LogEntry, LaunchResult } from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      launchAgents: (config: LaunchConfig) => Promise<LaunchResult>;
      stopAllAgents: () => Promise<{ stopped: number }>;
      getRunningAgents: () => Promise<RunningAgent[]>;
      pickDirectory: () => Promise<string | null>;
      onLogEntry: (callback: (entry: LogEntry) => void) => void;
      onAgentUpdate: (callback: (agent: RunningAgent) => void) => void;
      removeAllListeners: () => void;
    };
  }
}
