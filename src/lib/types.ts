export type AgentType = 'claude';

export type AgentStatus = 'starting' | 'running' | 'working' | 'asking' | 'done' | 'exited';

export interface AgentCard {
  id: string;
  type: AgentType;
  name: string;
  taskLabel: string;
  status: AgentStatus;
  workspaceId: string;
  cwd: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  expanded: boolean;
  minimized: boolean;
  epoch: number;
  lastLine: string;
  summary: string;
  accountId: string;
}

export interface DevicePreset {
  id: string;
  label: string;
  w: number;
  h: number;
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'iphone17promax', label: 'iPhone 17 Pro Max', w: 440, h: 956 },
  { id: 's26ultra', label: 'Samsung S26 Ultra', w: 480, h: 1040 },
  { id: 'iphone16', label: 'iPhone 16', w: 393, h: 852 },
  { id: 'pixel9', label: 'Pixel 9', w: 412, h: 915 },
  { id: 'iphonese', label: 'iPhone SE', w: 375, h: 667 },
  { id: 'laptop', label: 'Laptop', w: 1280, h: 800 },
  { id: 'pcmonitor', label: 'PC Monitor', w: 1920, h: 1080 },
];

export interface DockState {
  open: boolean;
  tab: 'browser' | 'editor';
  width: number;
  url: string;
  device: string;
  editorPath: string;
}

export type OrchestratorStatus = 'asleep' | 'awake' | 'listening' | 'thinking' | 'speaking';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface LogEntry {
  id: string;
  role: 'you' | 'orch' | 'event';
  text: string;
  at: number;
}

export interface OrchestratorState {
  status: OrchestratorStatus;
  messages: ChatMessage[];
  lastUser: string;
  lastReply: string;
  liveText: string;
  log: LogEntry[];
}

export interface WorkspaceState {
  id: string;
  name: string;
  configDir?: string;
  accountId: string;
  orchestrator: OrchestratorState;
  dock: DockState;
}

export interface ClaudeAccount {
  id: string;
  name: string;
  dir: string;
  loggedIn: boolean;
}

export interface LaunchPreset {
  id: string;
  label: string;
  count: number;
}

export interface Settings {
  talkKey: string;
  orchestratorModel: string;
  voiceModel: string;
  ttsEnabled: boolean;
  voiceReplies: boolean;
  announceDone: boolean;
  defaultCwd: string;
  claudeCommand: string;
  presets: LaunchPreset[];
  showTranscript: boolean;
  micDevice: string;
  micBackups: string[];
  tileMode: boolean;
  uiZoom: number;
  focusW: number;
  focusH: number;
}

export const GROQ_CHAT_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];
export const GROQ_VOICE_MODEL = 'whisper-large-v3-turbo';

export const DEFAULT_PRESETS: LaunchPreset[] = [
  { id: 'p1', label: '1 Claude', count: 1 },
  { id: 'p3', label: '3 Claude', count: 3 },
  { id: 'p6', label: '6 Claude', count: 6 },
];

export const DEFAULT_SETTINGS: Settings = {
  talkKey: 'Ctrl+Alt+O',
  orchestratorModel: 'llama-3.3-70b-versatile',
  voiceModel: GROQ_VOICE_MODEL,
  ttsEnabled: true,
  voiceReplies: true,
  announceDone: true,
  defaultCwd: 'C:\\dev',
  claudeCommand: 'claude --dangerously-skip-permissions',
  presets: DEFAULT_PRESETS,
  showTranscript: true,
  micDevice: '',
  micBackups: [],
  tileMode: true,
  uiZoom: 1,
  focusW: 560,
  focusH: 760,
};
