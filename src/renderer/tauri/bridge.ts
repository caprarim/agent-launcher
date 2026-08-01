import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AgentInstance,
  AgentType,
  FsReadDirResult,
  FsReadFileResult,
  FsWriteFileResult,
  PtyCreateOptions,
  PtyCreateResult,
} from '../../shared/types';
import { classifyLine, sanitizeTitle } from '../../shared/naming';

// The Linux (Tauri v2) backend for the launcher UI.
//
// Every React component talks to the host through `window.electronAPI`, so the
// port keeps that surface exactly as-is and re-implements it on top of Tauri's
// `invoke` + `listen`. Nothing in App/Workspace/TerminalPanel/EditorPanel needs
// to know which shell it is running inside, and the Electron build on Windows
// keeps working from the same source.
//
// The one deliberate difference is naming: the Rust side returns the model's RAW
// reply and the label rules stay here, in the same shared TypeScript module the
// offline heuristic already uses — so an LLM that answers a prompt instead of
// labelling it still gets filtered by exactly one implementation.

type Unsub = () => void;

const dataCallbacks = new Map<string, (data: string) => void>();
const exitCallbacks = new Map<string, (code: number) => void>();
const fsChangeCallbacks = new Set<(filePath: string) => void>();
const addAgentCallbacks = new Set<(requestId: string, type: AgentType) => void>();
const removeAgentCallbacks = new Set<(id: string) => void>();
const accountSwitchedCallbacks = new Set<(res: AccountSwitchEvent) => void>();
const renameCallbacks = new Set<(id: string, name: string) => void>();

interface AccountSwitchEvent {
  ok: boolean;
  email?: string;
  error?: string;
  reason: string;
  workspaceId?: string;
}

function pushRename(id: string, name: string): void {
  renameCallbacks.forEach((cb) => cb(id, name));
}

/**
 * Ask the model for a tab label, walking the fallback models in order. The raw
 * reply is untrusted — it only becomes a label if sanitizeTitle accepts it.
 */
async function suggestName(prompt: string): Promise<string | null> {
  let modelCount = 1;
  try {
    modelCount = await invoke<number>('ai_model_count');
  } catch (_e) {
    modelCount = 1;
  }
  for (let modelIndex = 0; modelIndex < modelCount; modelIndex++) {
    let raw: string | null = null;
    try {
      raw = await invoke<string | null>('ai_name_agent', { prompt, modelIndex });
    } catch (err) {
      console.warn('[namer] model call failed:', err);
      continue;
    }
    if (!raw) continue;
    const clean = sanitizeTitle(raw);
    if (clean) return clean;
    console.warn(`[namer] rejected ${JSON.stringify(raw.slice(0, 60))} (not a usable label)`);
  }
  return null;
}

// Labels for agents that never touch the keyboard. Anything driven over the
// control API (POST /agents/:id/input, /orchestrate) is written straight into
// the PTY, so TerminalPanel's keystroke watcher never sees a prompt for it and
// the tab would sit on "claude-agent-3" forever. The Rust control server hands
// the prompt over here; the rules live with the rest of the naming code.
function nameAgentFromPrompt(id: string, text: string): void {
  const { kind, title } = classifyLine(text);
  if (kind === 'clear') return pushRename(id, '');
  if (kind !== 'task') return;

  if (title) pushRename(id, title);
  suggestName(text)
    .then((aiTitle) => { if (aiTitle) pushRename(id, aiTitle); })
    .catch((err) => console.warn('[namer] control-path naming failed:', err));
}

function registerListeners(): void {
  listen<{ id: string; data: string }>('pty:data', ({ payload }) => {
    dataCallbacks.get(payload.id)?.(payload.data);
  });

  listen<{ id: string; exitCode: number }>('pty:exit', ({ payload }) => {
    exitCallbacks.get(payload.id)?.(payload.exitCode);
  });

  listen<string>('fs:changed', ({ payload }) => {
    fsChangeCallbacks.forEach((cb) => cb(payload));
  });

  listen<{ requestId: string; type: AgentType }>('control:add-agent', ({ payload }) => {
    addAgentCallbacks.forEach((cb) => cb(payload.requestId, payload.type));
  });

  listen<{ id: string }>('control:remove-agent', ({ payload }) => {
    removeAgentCallbacks.forEach((cb) => cb(payload.id));
  });

  listen<{ id: string; text: string }>('control:name-agent', ({ payload }) => {
    nameAgentFromPrompt(payload.id, payload.text);
  });

  listen<AccountSwitchEvent>('account:switched', ({ payload }) => {
    accountSwitchedCallbacks.forEach((cb) => cb(payload));
  });
}

interface PlatformInfo {
  platform: string;
  homeDir: string;
  defaultProjectPath: string;
  winBuildNumber: number;
}

export function installTauriBridge(info: PlatformInfo): void {
  registerListeners();

  window.electronAPI = {
    // PTY lifecycle. Output comes back over a per-terminal channel rather than
    // a broadcast event: five agents streaming at once is the normal case, and
    // a channel writes straight to the xterm instance that asked for it.
    ptyCreate: (opts: PtyCreateOptions): Promise<PtyCreateResult> => {
      const onData = new Channel<string>();
      onData.onmessage = (data) => { dataCallbacks.get(opts.id)?.(data); };
      return invoke<PtyCreateResult>('pty_create', { opts, onData });
    },

    ptyWrite: (id: string, data: string): void => {
      void invoke('pty_write', { id, data });
    },

    ptyResize: (id: string, cols: number, rows: number): void => {
      void invoke('pty_resize', { id, cols, rows });
    },

    ptyKill: (id: string): Promise<void> => invoke('pty_kill', { id }),

    onPtyData: (id: string, cb: (data: string) => void): Unsub => {
      dataCallbacks.set(id, cb);
      return () => { dataCallbacks.delete(id); };
    },

    onPtyExit: (id: string, cb: (code: number) => void): Unsub => {
      exitCallbacks.set(id, cb);
      return () => { exitCallbacks.delete(id); };
    },

    // Directory picker
    pickDirectory: (): Promise<string | null> =>
      invoke<string | null>('pick_directory'),

    // File system
    fsReadDir: (dirPath: string): Promise<FsReadDirResult> =>
      invoke<FsReadDirResult>('fs_read_dir', { dirPath }),

    fsReadFile: (filePath: string): Promise<FsReadFileResult> =>
      invoke<FsReadFileResult>('fs_read_file', { filePath }),

    fsWriteFile: (filePath: string, content: string): Promise<FsWriteFileResult> =>
      invoke<FsWriteFileResult>('fs_write_file', { filePath, content }),

    fsWatch: (filePath: string): Promise<void> => invoke('fs_watch', { filePath }),

    fsUnwatch: (filePath: string): Promise<void> => invoke('fs_unwatch', { filePath }),

    onFsChanged: (cb: (filePath: string) => void): Unsub => {
      fsChangeCallbacks.add(cb);
      return () => { fsChangeCallbacks.delete(cb); };
    },

    // Control API bridge
    syncAgents: (agents: AgentInstance[]): void => {
      void invoke('sync_agents', { agents });
    },

    onControlAddAgent: (cb: (requestId: string, type: AgentType) => void): Unsub => {
      addAgentCallbacks.add(cb);
      return () => { addAgentCallbacks.delete(cb); };
    },

    controlAddAgentResult: (requestId: string, agent: AgentInstance): void => {
      void invoke('control_add_agent_result', { requestId, agent });
    },

    onControlRemoveAgent: (cb: (id: string) => void): Unsub => {
      removeAgentCallbacks.add(cb);
      return () => { removeAgentCallbacks.delete(cb); };
    },

    // Claude account switching
    switchAccount: (workspaceId?: string, configDir?: string) =>
      invoke<{ ok: boolean; email?: string; error?: string }>('account_switch', {
        workspaceId: workspaceId ?? null,
        configDir: configDir ?? null,
      }),

    currentAccount: (configDir?: string) =>
      invoke<{ email: string | null }>('account_current', { configDir: configDir ?? null }),

    onAccountSwitched: (cb: (res: AccountSwitchEvent) => void): Unsub => {
      accountSwitchedCallbacks.add(cb);
      return () => { accountSwitchedCallbacks.delete(cb); };
    },

    ensureWorkspaceConfig: (workspaceId: string): Promise<string> =>
      invoke<string>('workspace_ensure_config', { workspaceId }),

    getControlPort: (): Promise<number> => invoke<number>('control_port'),

    // Agent tab naming
    nameAgentPrompt: (prompt: string): Promise<string | null> => suggestName(prompt),

    onAgentRename: (cb: (id: string, name: string) => void): Unsub => {
      renameCallbacks.add(cb);
      return () => { renameCallbacks.delete(cb); };
    },

    winBuildNumber: info.winBuildNumber,
    platform: info.platform,
    defaultProjectPath: info.defaultProjectPath,
    // WebKitGTK has no <webview> tag: the browser pane falls back to an iframe.
    hasWebview: false,
  };
}

export function loadPlatformInfo(): Promise<PlatformInfo> {
  return invoke<PlatformInfo>('platform_info');
}
