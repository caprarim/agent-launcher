import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as pty from 'node-pty';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { PtyCreateOptions, PtyCreateResult, AgentInstance, AgentType } from '../shared/types';
import { startControlServer } from './controlServer';
import * as accounts from './accounts';
import { suggestName, describeNamer } from './agentNamer';
import { classifyLine } from '../shared/naming';

const ptyMap = new Map<string, pty.IPty>();
const ptyMeta = new Map<string, { workspaceId?: string; configDir?: string; cwd: string; sessionId?: string }>();
const outputBuffers = new Map<string, string>();
const MAX_BUFFER = 200_000;
const watchMap = new Map<string, fs.FSWatcher>();

let agentsRegistry: AgentInstance[] = [];
const pendingAdds = new Map<string, (agent: AgentInstance) => void>();
let addCounter = 0;

const CONTROL_PORT = parseInt(process.env.AGENT_LAUNCHER_PORT || '4575', 10);
// The port the control API actually bound to — may differ from CONTROL_PORT
// when several launcher instances run at once (each takes the next free port).
let controlPort = CONTROL_PORT;

let mainWindow: BrowserWindow | null = null;

function appendOutput(id: string, data: string): void {
  const prev = outputBuffers.get(id) || '';
  let next = prev + data;
  if (next.length > MAX_BUFFER) next = next.slice(next.length - MAX_BUFFER);
  outputBuffers.set(id, next);
}

function createWindow(): void {
  const iconPath = path.join(__dirname, '../../assets/icon.ico');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Agent Launcher',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [id, proc] of ptyMap) {
      try { proc.kill(); } catch (_e) {}
      ptyMap.delete(id);
    }
    for (const [, w] of watchMap) { try { w.close(); } catch (_e) {} }
    watchMap.clear();
  });
}

// Multiple launchers may run side by side. The single-instance lock is used
// only to decide who owns the DEFAULT userData dir (existing workspaces,
// localStorage); every later launch claims a stable numbered instance dir so
// its Chromium caches, localStorage and per-workspace Claude configs don't
// collide with the primary's. Slots are reusable: a lock file holding the
// owner's pid marks a slot busy, and a slot whose pid is dead is reclaimed.
if (process.env.AGENT_LAUNCHER_USERDATA) {
  app.setPath('userData', process.env.AGENT_LAUNCHER_USERDATA);
}

let instanceLockFile: string | null = null;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (_e) { return false; }
}

function claimInstanceDir(): string {
  const base = path.join(app.getPath('appData'), 'agent-terminals', 'instances');
  for (let n = 2; n <= 20; n++) {
    const dir = path.join(base, `instance-${n}`);
    const lock = path.join(dir, 'instance.lock');
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(lock)) {
        const pid = parseInt(fs.readFileSync(lock, 'utf-8'), 10);
        if (pid && pidAlive(pid)) continue; // slot busy: a live launcher owns it
      }
      fs.writeFileSync(lock, String(process.pid), 'utf-8');
      instanceLockFile = lock;
      return dir;
    } catch (_e) { continue; }
  }
  // Never block a launch — fall back to a throwaway per-pid dir.
  return path.join(base, `instance-pid-${process.pid}`);
}

if (!app.requestSingleInstanceLock()) {
  // Another launcher owns this userData: run as an additional, fully
  // independent instance with its own data dir instead of quitting.
  app.setPath('userData', claimInstanceDir());
}

app.on('will-quit', () => {
  if (instanceLockFile) { try { fs.unlinkSync(instanceLockFile); } catch (_e) {} }
});

app.whenReady().then(() => {
  createWindow();
  accounts.startWatching();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const proc of ptyMap.values()) {
    try { proc.kill(); } catch (_e) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

// ── PTY: create ───────────────────────────────────────────────────────────────
function registryPath(root: string, key: string): string {
  try {
    const out = execFileSync('reg', ['query', root, '/v', key], { encoding: 'utf8' });
    const m = out.match(/\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function expandVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const found = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return found ? process.env[found] || whole : whole;
  });
}

function ptyEnv(): { [key: string]: string } {
  const env = { ...process.env } as { [key: string]: string };
  if (process.platform !== 'win32') return env;

  const machine = registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
  const user = registryPath('HKCU\\Environment', 'Path');

  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const merged = [expandVars(machine), expandVars(user), env[pathKey] || '']
    .flatMap((chunk) => chunk.split(';'))
    .map((dir) => dir.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const deduped = merged.filter((dir) => {
    const norm = dir.toLowerCase().replace(/\\+$/, '');
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });

  if (deduped.length) env[pathKey] = deduped.join(';');
  return env;
}

// Per-workspace Claude config dir. Deriving it here (not only in the renderer)
// guarantees a terminal can never fall back to the shared global ~/.claude just
// because it was created before the renderer resolved the workspace's dir —
// that fallback is what made an account switch bleed into other workspaces.
// The 'default' workspace intentionally keeps the global config.
function workspaceConfigDir(workspaceId: string): string {
  const dir = path.join(app.getPath('userData'), 'claude-workspaces', workspaceId);
  accounts.seedConfigDir(dir);
  accounts.watchConfigDir(dir);
  return dir;
}

function resolveConfigDir(workspaceId?: string, configDir?: string): string | undefined {
  if (configDir) return configDir;
  if (workspaceId && workspaceId !== 'default') return workspaceConfigDir(workspaceId);
  return undefined;
}

ipcMain.handle('pty:create', (_event, opts: PtyCreateOptions): PtyCreateResult => {
  try {
    const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    const env = ptyEnv();
    const configDir = resolveConfigDir(opts.workspaceId, opts.configDir);
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    // Agents inside the terminal must talk to THIS instance's control API,
    // not whichever instance got the default port first.
    env.AGENT_LAUNCHER_PORT = String(controlPort);
    const cwd = opts.cwd || os.homedir();
    // Claude terminals get a pinned session id so an account-switch restart
    // can resume THIS terminal's conversation. `--continue` can't: it resumes
    // the cwd's single most recent session, so several terminals in one
    // project all piled onto the same conversation and the rest were lost.
    let command = opts.command;
    let sessionId: string | undefined;
    if (opts.id.startsWith('claude-') && /^claude(\s|$)/.test(command) && !command.includes('--session-id')) {
      sessionId = randomUUID();
      command = `${command} --session-id ${sessionId}`;
    }
    const spawnOpts: pty.IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd,
      env,
    };

    // The Windows 10 inbox ConPTY (conhost) diffs the screen at a frame cadence
    // and silently drops lines that scroll through the viewport between frames,
    // so fast output never reaches xterm's scrollback and panes can't scroll up.
    // node-pty bundles a modern conpty.dll/OpenConsole.exe (from the Windows
    // Terminal repo) that emits scrolled-off lines correctly — prefer it.
    let proc: pty.IPty;
    if (process.platform === 'win32') {
      try {
        proc = pty.spawn(shell, [], { ...spawnOpts, useConptyDll: true });
      } catch (_e) {
        proc = pty.spawn(shell, [], spawnOpts);
      }
    } else {
      proc = pty.spawn(shell, [], spawnOpts);
    }

    ptyMap.set(opts.id, proc);
    ptyMeta.set(opts.id, { workspaceId: opts.workspaceId, configDir, cwd, sessionId });

    proc.onData((data) => {
      appendOutput(opts.id, data);
      if (opts.id.startsWith('claude-')) watchForUsageLimit(opts.id, data);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { id: opts.id, data });
      }
    });

    proc.onExit(({ exitCode }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { id: opts.id, exitCode });
      }
      ptyMap.delete(opts.id);
      ptyMeta.delete(opts.id);
    });

    const cmd = process.platform === 'win32' ? command + '\r' : command + '\n';
    setTimeout(() => {
      if (ptyMap.has(opts.id)) proc.write(cmd);
    }, 200);

    return { success: true, pid: proc.pid };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => {
  ptyMap.get(id)?.write(data);
});

ipcMain.on('pty:resize', (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  try { ptyMap.get(id)?.resize(cols, rows); } catch (_e) {}
});

ipcMain.handle('pty:kill', (_event, id: string): void => {
  const proc = ptyMap.get(id);
  if (proc) {
    try { proc.kill(); } catch (_e) {}
    ptyMap.delete(id);
  }
  ptyMeta.delete(id);
});

// ── Directory picker ──────────────────────────────────────────────────────────
ipcMain.handle('pick-directory', async (): Promise<string | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Directory',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── File system ───────────────────────────────────────────────────────────────
ipcMain.handle('fs:readdir', (_event, dirPath: string) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const IGNORE = new Set(['.git', 'node_modules', '__pycache__', '.next', 'dist', '.DS_Store']);
    return {
      entries: entries
        .filter((e) => !IGNORE.has(e.name))
        .map((e) => ({ name: e.name, path: path.join(dirPath, e.name), isDirectory: e.isDirectory() }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    };
  } catch (err) {
    return { entries: [], error: String(err) };
  }
});

ipcMain.handle('fs:readfile', (_event, filePath: string) => {
  try {
    return { content: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    return { content: '', error: String(err) };
  }
});

ipcMain.handle('fs:writefile', (_event, filePath: string, content: string) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('fs:watch', (_event, filePath: string): void => {
  if (watchMap.has(filePath)) return;
  try {
    const watcher = fs.watch(filePath, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fs:changed', filePath);
      }
    });
    watchMap.set(filePath, watcher);
  } catch (_e) {}
});

ipcMain.handle('fs:unwatch', (_event, filePath: string): void => {
  const w = watchMap.get(filePath);
  if (w) { w.close(); watchMap.delete(filePath); }
});

// ── Claude account switching ──────────────────────────────────────────────────
// When a Claude terminal prints a "limit reached" message, swap to the other
// stored account and restart the claude CLIs so they pick up the new tokens.
// Matches only hard "limit reached" wording — NOT promo banners ("If you hit
// your limit ...") or "Approaching ... limit" warnings.
const LIMIT_REACHED_RE =
  /(?:5-hour|weekly|session|usage|rate)\s+limit\s+reached|reached\s+your\s+(?:5-hour|weekly|session|usage|rate)\s+limit/i;
const AUTO_SWITCH_COOLDOWN_MS = 5 * 60_000;
const limitTails = new Map<string, string>();
const lastAutoSwitchAt = new Map<string, number>();

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

function watchForUsageLimit(id: string, data: string): void {
  const tail = ((limitTails.get(id) || '') + stripAnsi(data)).slice(-600);
  limitTails.set(id, tail);
  if (!LIMIT_REACHED_RE.test(tail)) return;
  limitTails.set(id, '');
  const meta = ptyMeta.get(id);
  const wsKey = meta?.workspaceId || 'default';
  const now = Date.now();
  if (now - (lastAutoSwitchAt.get(wsKey) || 0) < AUTO_SWITCH_COOLDOWN_MS) return;
  lastAutoSwitchAt.set(wsKey, now);
  void performAccountSwitch('limit', meta?.workspaceId, meta?.configDir);
}

// The command that brings a claude terminal back after an account switch.
// Each terminal resumes ITS OWN conversation via its pinned session id;
// `--session-id` (start fresh on the pinned id) is used when the terminal has
// no session file yet, i.e. nothing was ever said in it. Terminals created by
// an older build have no pinned id and keep the old `--continue` behavior.
function claudeRelaunchCommand(id: string): string {
  const base = 'claude --dangerously-skip-permissions';
  const meta = ptyMeta.get(id);
  if (!meta?.sessionId) return `${base} --continue`;
  const cfgDir = meta.configDir || path.join(os.homedir(), '.claude');
  const projSlug = meta.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionFile = path.join(cfgDir, 'projects', projSlug, `${meta.sessionId}.jsonl`);
  return fs.existsSync(sessionFile)
    ? `${base} --resume ${meta.sessionId}`
    : `${base} --session-id ${meta.sessionId}`;
}

function performAccountSwitch(reason: 'manual' | 'limit', workspaceId?: string, configDir?: string): Promise<accounts.SwitchResult> {
  // Re-derive the dir so a switch requested before the renderer learned the
  // workspace's configDir still stays scoped to that workspace instead of
  // rewriting the global ~/.claude shared by everything else.
  const dir = resolveConfigDir(workspaceId, configDir);
  const notify = (res: accounts.SwitchResult): accounts.SwitchResult => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('account:switched', { ...res, reason, workspaceId });
    }
    return res;
  };
  // Bail before touching any terminal if the swap can't happen anyway.
  const blocked = accounts.canSwitch();
  if (blocked) return Promise.resolve(notify({ ok: false, error: blocked }));

  // Exit every claude REPL in the workspace FIRST (Esc dismisses menus /
  // stops streaming, double Ctrl+C quits), and only swap the credential files
  // once they are gone. Swapping while claude was still alive let the dying
  // process flush its in-memory .claude.json / refreshed tokens over the
  // freshly written files — which is how a switch could land on a dead login.
  const claudes = agentsRegistry.filter((agent) =>
    agent.type === 'claude' &&
    (agent.workspaceId || undefined) === (workspaceId || undefined) &&
    ptyMap.has(agent.id));
  for (const agent of claudes) {
    const proc = ptyMap.get(agent.id)!;
    try { proc.write('\x1b'); } catch (_e) {}
    setTimeout(() => { try { ptyMap.get(agent.id)?.write('\x03'); } catch (_e) {} }, 400);
    setTimeout(() => { try { ptyMap.get(agent.id)?.write('\x03'); } catch (_e) {} }, 700);
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const res = accounts.switchAccount(dir);
      // Relaunch even if the swap failed — the REPLs were already exited, and
      // each terminal resumes its own conversation either way.
      for (const agent of claudes) {
        try { ptyMap.get(agent.id)?.write(claudeRelaunchCommand(agent.id) + '\r'); } catch (_e) {}
      }
      resolve(notify(res));
    }, claudes.length > 0 ? 2500 : 0);
  });
}

ipcMain.handle('account:switch', (_event, args?: { workspaceId?: string; configDir?: string }) =>
  performAccountSwitch('manual', args?.workspaceId, args?.configDir));
ipcMain.handle('account:current', (_event, configDir?: string) => ({ email: accounts.currentEmail(configDir) }));

ipcMain.handle('workspace:ensure-config', (_event, workspaceId: string): string =>
  workspaceConfigDir(workspaceId));

ipcMain.handle('control:port', (): number => controlPort);

// ── Agent tab naming ──────────────────────────────────────────────────────────
// Used by the renderer, which watches keystrokes in xterm and already has the
// instant heuristic label on screen by the time this resolves.
ipcMain.handle('ai:name-agent', (_event, prompt: string): Promise<string | null> =>
  suggestName(prompt),
);

// Push a new label for a tab to the renderer, which owns agent state. An empty
// name means "reset to the default" (the agent was /clear'd).
function pushRename(id: string, name: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:rename', { id, name });
  }
}

// Name an agent from a prompt that arrived over the control API rather than the
// keyboard. This is the other half of the bug: POST /agents/:id/input and
// /orchestrate write straight into the PTY, so they never pass through xterm's
// onData handler in TerminalPanel — which is the only thing that used to feed
// the namer. Every agent spawned and tasked by an orchestrating agent therefore
// kept its "claude-agent-3" placeholder forever, no matter what it was doing.
//
// Mirrors the renderer's flow: instant heuristic label, then the model refines it.
function nameAgentFromPrompt(id: string, text: string): void {
  const { kind, title } = classifyLine(text);
  if (kind === 'clear') return pushRename(id, '');
  if (kind !== 'task') return;

  if (title) pushRename(id, title);
  suggestName(text)
    .then((aiTitle) => { if (aiTitle) pushRename(id, aiTitle); })
    .catch((err) => console.warn('[namer] control-path naming failed:', err));
}

// ── Control API bridge ────────────────────────────────────────────────────────
ipcMain.on('control:sync-agents', (_event, agents: AgentInstance[]) => {
  agentsRegistry = Array.isArray(agents) ? agents : [];
});

ipcMain.on('control:add-agent-result', (_event, { requestId, agent }: { requestId: string; agent: AgentInstance }) => {
  const resolve = pendingAdds.get(requestId);
  if (resolve) {
    pendingAdds.delete(requestId);
    resolve(agent);
  }
});

function bridgeAddAgent(type: AgentType): Promise<AgentInstance> {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return reject(new Error('App window is not open'));
    }
    const requestId = `add-${Date.now()}-${addCounter++}`;
    const timer = setTimeout(() => {
      pendingAdds.delete(requestId);
      reject(new Error('Timed out waiting for the app to create the agent'));
    }, 15_000);

    pendingAdds.set(requestId, async (agent) => {
      const deadline = Date.now() + 8_000;
      while (!ptyMap.has(agent.id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      clearTimeout(timer);
      resolve(agent);
    });

    mainWindow.webContents.send('control:add-agent', { requestId, type });
  });
}

function bridgeRemoveAgent(id: string): Promise<boolean> {
  if (!agentsRegistry.some((a) => a.id === id)) return Promise.resolve(false);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('control:remove-agent', { id });
  }
  const proc = ptyMap.get(id);
  if (proc) { try { proc.kill(); } catch (_e) {} ptyMap.delete(id); }
  ptyMeta.delete(id);
  outputBuffers.delete(id);
  return Promise.resolve(true);
}

startControlServer(
  {
    getAgents: () => agentsRegistry,
    addAgent: bridgeAddAgent,
    removeAgent: bridgeRemoveAgent,
    writeInput: (id, text) => {
      const proc = ptyMap.get(id);
      if (!proc) return false;
      proc.write(text);
      return true;
    },
    nameAgent: nameAgentFromPrompt,
    readOutput: (id, opts) => {
      if (!agentsRegistry.some((a) => a.id === id) && !outputBuffers.has(id)) return null;
      const buf = outputBuffers.get(id) || '';
      if (opts.tail && opts.tail > 0 && buf.length > opts.tail) {
        return buf.slice(buf.length - opts.tail);
      }
      return buf;
    },
    hasPty: (id) => ptyMap.has(id),
  },
  CONTROL_PORT,
  (port) => { controlPort = port; },
);

console.log(describeNamer());
