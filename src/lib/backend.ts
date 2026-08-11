import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ClaudeAccount } from './types';

export interface PtyCreateArgs {
  id: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  workspaceId?: string;
  configDir?: string;
}

export const backend = {
  ptyCreate: (opts: PtyCreateArgs) =>
    invoke<{ success: boolean; pid?: number; error?: string; existing?: boolean }>('pty_create', { opts }),
  ptyWrite: (id: string, data: string) => invoke<boolean>('pty_write', { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>('pty_kill', { id }),
  ptyOutput: (id: string, tail = 4000, raw = false) =>
    invoke<string>('pty_output', { id, tail, raw }),
  focusMain: () => invoke<void>('focus_main').catch(() => {}),
  clipboardImageFile: () => invoke<string>('clipboard_image_file'),
  setUiZoom: (factor: number) => invoke<void>('set_ui_zoom', { factor }),
  focusMode: (on: boolean, width: number, height: number, title?: string) =>
    invoke<void>('focus_mode', { on, width, height, title }),
  groqChat: (body: unknown) => invoke<GroqChatResponse>('groq_chat', { body }),
  groqCancel: () => invoke<void>('groq_cancel'),
  groqKeyPresent: () => invoke<boolean>('groq_key_present'),
  groqKeySet: (key: string) => invoke<void>('groq_key_set', { key }),
  speak: (text: string) => invoke<void>('speak', { text }),
  speakStop: () => invoke<void>('speak_stop'),
  voiceStart: (devices: string[] = []) => invoke<void>('voice_start', { devices }),
  voiceStop: () => invoke<string>('voice_stop'),
  listInputDevices: () => invoke<string[]>('list_input_devices'),
  defaultInputDevice: () => invoke<string | null>('default_input_device'),
  ensureWorkspaceConfig: (workspaceId: string) =>
    invoke<string>('ensure_workspace_config', { workspaceId }),
  listAccounts: () => invoke<ClaudeAccount[]>('list_accounts'),
  createAccount: (name: string) => invoke<ClaudeAccount>('create_account', { name }),
  listDir: (path: string) => invoke<DirEntry[]>('list_dir', { path }),
  readTextFile: (path: string) => invoke<string>('read_text_file', { path }),
  writeTextFile: (path: string, content: string) => invoke<void>('write_text_file', { path, content }),
  openExternal: (url: string) => invoke<void>('open_external', { url }).catch(() => {}),
  browserShow: (url: string, x: number, y: number, w: number, h: number) =>
    invoke<void>('browser_show', { url, x, y, w, h }),
  browserNavigate: (url: string) => invoke<void>('browser_navigate', { url }).catch(() => {}),
  browserHide: () => invoke<void>('browser_hide').catch(() => {}),
  browserClose: () => invoke<void>('browser_close').catch(() => {}),
  browserNavAction: (action: 'back' | 'forward' | 'reload') =>
    invoke<void>('browser_nav_action', { action }).catch(() => {}),
  updateCheck: () => invoke<UpdateInfo>('update_check'),
  updateApply: () => invoke<void>('update_apply'),
  usageGet: (id?: string, configDir?: string) => invoke<Usage>('usage_get', { id, configDir }),
};

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

export interface Usage {
  session: UsageWindow | null;
  week: UsageWindow | null;
  source: string;
  ageMs: number;
  account: string | null;
  error: string | null;
}

export interface UpdateInfo {
  available: boolean;
  version: string;
  currentBuilt: number;
  newestBuilt: number;
  source: string;
  message: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface GroqChatResponse {
  choices?: {
    message?: {
      role: string;
      content: string | null;
      tool_calls?: {
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  error?: { message?: string };
}

type Handler<T> = (payload: T) => void;

export function onEvent<T>(name: string, handler: Handler<T>): Promise<UnlistenFn> {
  return listen<T>(name, (e) => handler(e.payload));
}

export function dlog(text: string): void {
  void invoke('debug_log', { line: text }).catch(() => {});
}

const screenBus = new Map<string, () => string>();

export function bindScreen(id: string, reader: () => string): () => void {
  screenBus.set(id, reader);
  return () => {
    if (screenBus.get(id) === reader) screenBus.delete(id);
  };
}

export function readScreen(id: string): string | undefined {
  try {
    return screenBus.get(id)?.();
  } catch (_e) {
    return undefined;
  }
}

const dataBus = new Map<string, (data: string) => void>();

export function bindTerminal(id: string, sink: (data: string) => void): () => void {
  dataBus.set(id, sink);
  return () => {
    if (dataBus.get(id) === sink) dataBus.delete(id);
  };
}

export function feedTerminal(id: string, data: string): void {
  dataBus.get(id)?.(data);
}
