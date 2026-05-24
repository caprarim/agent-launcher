import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';
import { LaunchConfig, RunningAgent, LogEntry, LaunchResult } from '../shared/types';

const TMUX_SESSION = 'agent-launcher';

// Track all running child processes (terminal handles) for cleanup
const runningProcesses: Map<string, ChildProcess> = new Map();
const runningAgents: Map<string, RunningAgent> = new Map();

let mainWindow: BrowserWindow | null = null;
let usingTmux = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(rendererPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
    killAllProcesses();
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killAllProcesses();
  if (process.platform !== 'darwin') app.quit();
});

function killAllProcesses(): void {
  // Kill tmux session first if we used it
  if (usingTmux) {
    try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch (_e) {}
  }
  for (const [id, proc] of runningProcesses.entries()) {
    try {
      if (proc.pid) {
        if (process.platform !== 'win32') {
          try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e) { proc.kill(); }
        } else {
          proc.kill();
        }
      }
    } catch (_e) {}
    runningProcesses.delete(id);
  }
  runningAgents.clear();
  usingTmux = false;
}

function sendLog(entry: LogEntry): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-entry', entry);
  }
}

function sendAgentUpdate(agent: RunningAgent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent-update', agent);
  }
}

function makeTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(level: LogEntry['level'], message: string): void {
  const entry: LogEntry = { timestamp: makeTimestamp(), level, message };
  sendLog(entry);
  console.log(`[${level.toUpperCase()}] ${message}`);
}

function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch (_e) {
    return false;
  }
}

function detectLinuxTerminal(): string {
  const candidates = ['gnome-terminal', 'xfce4-terminal', 'konsole', 'xterm', 'alacritty', 'kitty', 'mate-terminal', 'tilix'];
  for (const term of candidates) {
    try {
      const found = execSync(`which ${term} 2>/dev/null`).toString().trim();
      if (found) return term;
    } catch (_e) {}
  }
  return 'xterm';
}

// ─── Strategy A: tmux (preferred on macOS/Linux) ─────────────────────────────
// Builds a shell script that creates one tmux session with one window per agent,
// then opens a single terminal attached to that session.
function spawnAllViaTmux(
  instances: Array<{ name: string; command: string }>,
  workDir: string,
  addLog: (level: LogEntry['level'], msg: string) => void
): ChildProcess | null {
  const platform = process.platform;
  const safeDir = workDir.replace(/'/g, "'\\''");

  // Build the setup script
  const scriptLines = [
    '#!/usr/bin/env bash',
    `tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`,
    // First window uses new-session
    `tmux new-session -d -s ${TMUX_SESSION} -n "${instances[0].name}" -x 220 -y 50`,
    `tmux send-keys -t '${TMUX_SESSION}:0' "cd '${safeDir}' && ${instances[0].command}" Enter`,
  ];

  for (let i = 1; i < instances.length; i++) {
    scriptLines.push(`tmux new-window -t ${TMUX_SESSION}: -n "${instances[i].name}"`);
    scriptLines.push(`tmux send-keys -t '${TMUX_SESSION}:' "cd '${safeDir}' && ${instances[i].command}" Enter`);
  }

  scriptLines.push(`tmux select-window -t '${TMUX_SESSION}:0'`);
  scriptLines.push(`tmux attach -t ${TMUX_SESSION}`);

  const scriptPath = path.join(os.tmpdir(), 'agent-launcher.sh');
  fs.writeFileSync(scriptPath, scriptLines.join('\n'), { mode: 0o755 });

  addLog('info', `tmux script written to ${scriptPath}`);
  addLog('info', `Switch agents with: Ctrl+B n (next) / Ctrl+B p (prev) / Ctrl+B w (list)`);

  // Open a terminal running the script
  let termProc: ChildProcess | null = null;

  if (platform === 'darwin') {
    const script = `tell application "Terminal"
  activate
  do script "bash '${scriptPath.replace(/'/g, "'\\''")}'"
end tell`;
    termProc = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
  } else if (platform === 'linux') {
    const term = detectLinuxTerminal();
    const attachCmd = `bash '${scriptPath}'`;
    switch (term) {
      case 'gnome-terminal':
        termProc = spawn('gnome-terminal', ['--', 'bash', '-c', `bash '${scriptPath}'; exec bash`], { detached: true, stdio: 'ignore' });
        break;
      case 'xfce4-terminal':
        termProc = spawn('xfce4-terminal', ['-e', `bash -c "bash '${scriptPath}'; exec bash"`], { detached: true, stdio: 'ignore' });
        break;
      case 'konsole':
        termProc = spawn('konsole', ['-e', 'bash', '-c', `bash '${scriptPath}'; exec bash`], { detached: true, stdio: 'ignore' });
        break;
      case 'alacritty':
        termProc = spawn('alacritty', ['-e', 'bash', '-c', `bash '${scriptPath}'`], { detached: true, stdio: 'ignore' });
        break;
      case 'kitty':
        termProc = spawn('kitty', ['bash', '-c', `bash '${scriptPath}'`], { detached: true, stdio: 'ignore' });
        break;
      default: // xterm
        termProc = spawn('xterm', ['-e', 'bash', '-c', `bash '${scriptPath}'; exec bash`], { detached: true, stdio: 'ignore' });
    }
    addLog('info', `Terminal: ${term}`);
  }

  return termProc;
}

// ─── Strategy B: one terminal window per agent (fallback / Windows) ──────────
function buildSingleTerminalArgs(
  workDir: string,
  command: string,
  title: string,
  linuxTerm: string
): { cmd: string; args: string[] } | null {
  const platform = process.platform;
  const safeDir = workDir.replace(/'/g, "'\\''");
  const shellCmd = `cd '${safeDir}' && ${command}; exec bash`;

  if (platform === 'darwin') {
    const escapedCmd = command.replace(/'/g, "'\\''");
    const script = `tell application "Terminal"
  activate
  set t to do script "cd '${safeDir}' && printf '\\033]0;${title}\\007' && ${escapedCmd}"
end tell`;
    return { cmd: 'osascript', args: ['-e', script] };
  }

  if (platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', `"${title}"`, 'cmd', '/k', `cd /d "${workDir}" && ${command}`] };
  }

  switch (linuxTerm) {
    case 'gnome-terminal':  return { cmd: 'gnome-terminal', args: ['--title', title, '--', 'bash', '-c', shellCmd] };
    case 'xfce4-terminal':  return { cmd: 'xfce4-terminal', args: ['--title', title, '-e', `bash -c "${shellCmd}"`] };
    case 'konsole':         return { cmd: 'konsole', args: ['--title', title, '-e', 'bash', '-c', shellCmd] };
    case 'alacritty':       return { cmd: 'alacritty', args: ['--title', title, '-e', 'bash', '-c', shellCmd] };
    case 'kitty':           return { cmd: 'kitty', args: ['--title', title, 'bash', '-c', shellCmd] };
    default:                return { cmd: 'xterm', args: ['-title', title, '-e', 'bash', '-c', shellCmd] };
  }
}

// ─── IPC: launch agents ───────────────────────────────────────────────────────
ipcMain.handle('launch-agents', async (_event, config: LaunchConfig): Promise<LaunchResult> => {
  const logs: LogEntry[] = [];
  const agents: RunningAgent[] = [];

  const addLog = (level: LogEntry['level'], message: string) => {
    const entry: LogEntry = { timestamp: makeTimestamp(), level, message };
    logs.push(entry);
    sendLog(entry);
  };

  const totalCount = config.agents.reduce((sum, a) => sum + a.count, 0);
  if (totalCount > config.maxAgents) {
    const msg = `Total agents (${totalCount}) exceeds max limit (${config.maxAgents}).`;
    addLog('error', msg);
    return { success: false, agents: [], logs, error: msg };
  }
  if (totalCount === 0) {
    addLog('warn', 'No agents configured to launch.');
    return { success: false, agents: [], logs, error: 'No agents to launch.' };
  }

  const workDir = config.projectPath?.trim() || process.cwd();
  if (!fs.existsSync(workDir)) {
    const msg = `Project path does not exist: ${workDir}`;
    addLog('error', msg);
    return { success: false, agents: [], logs, error: msg };
  }
  addLog('info', `Working directory: ${workDir}`);

  const promptSuffix = config.initialPrompt?.trim()
    ? ` ${JSON.stringify(config.initialPrompt.trim())}`
    : '';

  // Build flat list of agent instances
  const instances: Array<{ id: string; name: string; type: string; command: string }> = [];
  for (const agentConfig of config.agents) {
    if (agentConfig.count <= 0) continue;
    if (!agentConfig.command?.trim()) {
      addLog('error', `Command for ${agentConfig.type} is empty — skipping.`);
      continue;
    }
    for (let i = 1; i <= agentConfig.count; i++) {
      const name = `${agentConfig.type}-agent-${i}`;
      const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      instances.push({ id, name, type: agentConfig.type, command: agentConfig.command.trim() + promptSuffix });
    }
  }

  if (instances.length === 0) {
    addLog('error', 'No valid agents to launch after validation.');
    return { success: false, agents: [], logs, error: 'No valid agents.' };
  }

  // Kill any existing session before launching
  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch (_e) {}

  const useTmux = process.platform !== 'win32' && isTmuxAvailable();
  usingTmux = useTmux;

  if (useTmux) {
    // ── Strategy A: one tmux session, one window per agent ──
    addLog('info', `Using tmux: ${instances.length} agent windows in one terminal session.`);

    const termProc = spawnAllViaTmux(instances, workDir, addLog);

    for (const inst of instances) {
      const agent: RunningAgent = {
        id: inst.id,
        name: inst.name,
        type: inst.type,
        pid: termProc?.pid,
        status: termProc ? 'running' : 'error',
        startedAt: new Date(),
      };
      runningAgents.set(inst.id, agent);
      sendAgentUpdate(agent);
      agents.push(agent);
    }

    if (termProc) {
      // Track the terminal process with a combined key
      runningProcesses.set('tmux-terminal', termProc);
      termProc.unref();
      addLog('success', `Launched ${instances.length} agents in tmux session "${TMUX_SESSION}".`);
      if (promptSuffix) addLog('info', 'Initial prompt passed as argument to each agent command.');
    } else if (process.platform === 'linux') {
      addLog('warn', 'Could not open terminal window automatically.');
      addLog('info', `Manually run: tmux attach -t ${TMUX_SESSION}`);
    }
  } else {
    // ── Strategy B: one terminal window per agent ──
    const linuxTerm = process.platform === 'linux' ? detectLinuxTerminal() : '';
    if (process.platform === 'linux') addLog('info', `Terminal emulator: ${linuxTerm}`);

    let anyFailed = false;

    for (const inst of instances) {
      addLog('info', `Launching ${inst.name}...`);

      const termArgs = buildSingleTerminalArgs(workDir, inst.command, inst.name, linuxTerm);
      if (!termArgs) {
        addLog('error', `Could not build terminal command for ${inst.name}`);
        anyFailed = true;
        continue;
      }

      const agent: RunningAgent = { id: inst.id, name: inst.name, type: inst.type, status: 'starting', startedAt: new Date() };

      try {
        const proc = spawn(termArgs.cmd, termArgs.args, { detached: process.platform !== 'win32', stdio: 'ignore', cwd: workDir });

        if (proc.pid) {
          agent.pid = proc.pid;
          agent.status = 'running';
          runningProcesses.set(inst.id, proc);
          addLog('success', `Started ${inst.name} — PID: ${proc.pid}`);
        } else {
          agent.status = 'error';
          addLog('error', `No PID for ${inst.name}`);
          anyFailed = true;
        }

        proc.on('error', (err) => {
          agent.status = 'error';
          runningAgents.set(inst.id, agent);
          sendAgentUpdate(agent);
          log('error', `${inst.name}: ${err.message}`);
        });
        proc.on('close', (code) => {
          agent.status = 'stopped';
          runningAgents.set(inst.id, agent);
          runningProcesses.delete(inst.id);
          sendAgentUpdate(agent);
          log('info', `${inst.name} exited (${code})`);
        });
        proc.unref();

        runningAgents.set(inst.id, agent);
        sendAgentUpdate(agent);
        agents.push(agent);

        await new Promise((r) => setTimeout(r, 300));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        agent.status = 'error';
        addLog('error', `Failed to launch ${inst.name}: ${message}`);
        anyFailed = true;
        agents.push(agent);
      }
    }

    if (promptSuffix) addLog('info', 'Initial prompt passed as argument to each agent command.');
    addLog(anyFailed ? 'warn' : 'success', `Launch complete. ${agents.filter((a) => a.status === 'running').length} agents running.`);
  }

  return { success: true, agents, logs };
});

// ─── IPC: stop all agents ─────────────────────────────────────────────────────
ipcMain.handle('stop-all-agents', async (): Promise<{ stopped: number }> => {
  let stopped = 0;

  if (usingTmux) {
    try {
      execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`);
      stopped = runningAgents.size;
      log('info', `Killed tmux session "${TMUX_SESSION}". (${stopped} agents stopped)`);
    } catch (_e) {}
    usingTmux = false;
  }

  for (const [id, proc] of runningProcesses.entries()) {
    try {
      if (proc.pid) {
        if (process.platform !== 'win32') {
          try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e) { proc.kill(); }
        } else {
          proc.kill();
        }
        stopped++;
      }
    } catch (_e) {}
    runningProcesses.delete(id);
  }

  for (const [id, agent] of runningAgents.entries()) {
    agent.status = 'stopped';
    runningAgents.set(id, agent);
    sendAgentUpdate(agent);
  }

  log('info', `Stopped all agents. (${stopped} processes terminated)`);
  return { stopped };
});

// ─── IPC: get running agents ──────────────────────────────────────────────────
ipcMain.handle('get-running-agents', async (): Promise<RunningAgent[]> => {
  return Array.from(runningAgents.values());
});

// ─── IPC: directory picker ────────────────────────────────────────────────────
ipcMain.handle('pick-directory', async (): Promise<string | null> => {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select Project Directory',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
