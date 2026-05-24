import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, ChildProcess, exec } from 'child_process';
import { LaunchConfig, RunningAgent, LogEntry, LaunchResult } from '../shared/types';

// Track all running child processes for cleanup
const runningProcesses: Map<string, ChildProcess> = new Map();
const runningAgents: Map<string, RunningAgent> = new Map();

let mainWindow: BrowserWindow | null = null;

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
    icon: undefined,
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

// Kill all tracked processes on exit
function killAllProcesses(): void {
  for (const [id, proc] of runningProcesses.entries()) {
    try {
      if (proc.pid) {
        // Kill process group on Unix, or just the process on Windows
        if (process.platform !== 'win32') {
          process.kill(-proc.pid, 'SIGTERM');
        } else {
          proc.kill();
        }
      }
    } catch (_e) {
      // Already dead — ignore
    }
    runningProcesses.delete(id);
  }
  runningAgents.clear();
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

// Detect available terminal on Linux
function detectLinuxTerminal(): string | null {
  const terminals = [
    'gnome-terminal',
    'xfce4-terminal',
    'konsole',
    'xterm',
    'mate-terminal',
    'tilix',
    'alacritty',
    'kitty',
  ];
  for (const term of terminals) {
    try {
      const result = require('child_process').execSync(`which ${term} 2>/dev/null`).toString().trim();
      if (result) return term;
    } catch (_e) {
      // Not found
    }
  }
  return null;
}

// Build the shell command to open a new terminal window running a command
function buildTerminalCommand(
  terminalName: string,
  workDir: string,
  agentCommand: string,
  title: string
): { cmd: string; args: string[] } | null {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: use osascript to open Terminal.app with the command
    const escapedCmd = agentCommand.replace(/'/g, "'\\''");
    const escapedDir = workDir.replace(/'/g, "'\\''");
    const script = `tell application "Terminal"
  activate
  set newTab to do script "cd '${escapedDir}' && printf '\\033]0;${title}\\007' && ${escapedCmd}"
end tell`;
    return { cmd: 'osascript', args: ['-e', script] };
  }

  if (platform === 'win32') {
    // Windows: start a new cmd window
    return {
      cmd: 'cmd',
      args: ['/c', 'start', `"${title}"`, 'cmd', '/k', `cd /d "${workDir}" && ${agentCommand}`],
    };
  }

  // Linux: use detected terminal
  const term = terminalName || detectLinuxTerminal() || 'xterm';
  const shellCmd = `cd '${workDir}' && ${agentCommand}; exec bash`;

  switch (term) {
    case 'gnome-terminal':
      return { cmd: 'gnome-terminal', args: ['--title', title, '--', 'bash', '-c', shellCmd] };
    case 'xfce4-terminal':
      return { cmd: 'xfce4-terminal', args: ['--title', title, '-e', `bash -c "${shellCmd}"`] };
    case 'konsole':
      return { cmd: 'konsole', args: ['--title', title, '-e', 'bash', '-c', shellCmd] };
    case 'alacritty':
      return { cmd: 'alacritty', args: ['--title', title, '-e', 'bash', '-c', shellCmd] };
    case 'kitty':
      return { cmd: 'kitty', args: ['--title', title, 'bash', '-c', shellCmd] };
    case 'mate-terminal':
      return { cmd: 'mate-terminal', args: ['--title', title, '-e', `bash -c "${shellCmd}"`] };
    case 'tilix':
      return { cmd: 'tilix', args: ['--title', title, '-e', `bash -c "${shellCmd}"`] };
    case 'xterm':
    default:
      return { cmd: 'xterm', args: ['-title', title, '-e', 'bash', '-c', shellCmd] };
  }
}

// Main IPC handler: launch agents
ipcMain.handle('launch-agents', async (_event, config: LaunchConfig): Promise<LaunchResult> => {
  const logs: LogEntry[] = [];
  const agents: RunningAgent[] = [];

  const addLog = (level: LogEntry['level'], message: string) => {
    const entry: LogEntry = { timestamp: makeTimestamp(), level, message };
    logs.push(entry);
    sendLog(entry);
  };

  // Validate total agent count
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

  // Resolve working directory
  const workDir = config.projectPath && config.projectPath.trim() !== ''
    ? config.projectPath.trim()
    : process.cwd();

  if (!fs.existsSync(workDir)) {
    const msg = `Project path does not exist: ${workDir}`;
    addLog('error', msg);
    return { success: false, agents: [], logs, error: msg };
  }

  addLog('info', `Working directory: ${workDir}`);

  // Detect terminal once for Linux
  const linuxTerm = process.platform === 'linux' ? (detectLinuxTerminal() || 'xterm') : '';
  if (process.platform === 'linux') {
    addLog('info', `Using terminal emulator: ${linuxTerm}`);
  }

  // Handle initial prompt: if provided, append as quoted argument to command
  const promptSuffix = config.initialPrompt && config.initialPrompt.trim() !== ''
    ? ` ${JSON.stringify(config.initialPrompt.trim())}`
    : '';

  let anyFailed = false;

  for (const agentConfig of config.agents) {
    if (agentConfig.count <= 0) continue;
    if (!agentConfig.command || agentConfig.command.trim() === '') {
      addLog('error', `Command for ${agentConfig.type} is empty — skipping.`);
      anyFailed = true;
      continue;
    }

    for (let i = 1; i <= agentConfig.count; i++) {
      const agentName = `${agentConfig.type}-agent-${i}`;
      const agentId = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const fullCommand = agentConfig.command.trim() + promptSuffix;

      addLog('info', `Launching ${agentName}...`);

      const termArgs = buildTerminalCommand(linuxTerm, workDir, fullCommand, agentName);
      if (!termArgs) {
        addLog('error', `Could not determine terminal command for ${agentName}`);
        anyFailed = true;
        continue;
      }

      const agent: RunningAgent = {
        id: agentId,
        name: agentName,
        type: agentConfig.type,
        status: 'starting',
        startedAt: new Date(),
      };

      try {
        const proc = spawn(termArgs.cmd, termArgs.args, {
          detached: process.platform !== 'win32',
          stdio: 'ignore',
          cwd: workDir,
        });

        if (proc.pid) {
          agent.pid = proc.pid;
          agent.status = 'running';
          runningProcesses.set(agentId, proc);
          runningAgents.set(agentId, agent);

          addLog('success', `Started ${agentName} — PID: ${proc.pid}`);
        } else {
          agent.status = 'error';
          addLog('error', `Failed to get PID for ${agentName}`);
          anyFailed = true;
        }

        proc.on('error', (err) => {
          agent.status = 'error';
          runningAgents.set(agentId, agent);
          sendAgentUpdate(agent);
          log('error', `${agentName} error: ${err.message}`);
        });

        proc.on('close', (code) => {
          agent.status = 'stopped';
          runningAgents.set(agentId, agent);
          runningProcesses.delete(agentId);
          sendAgentUpdate(agent);
          log('info', `${agentName} exited with code ${code}`);
        });

        // Unref so Electron main process doesn't wait for terminal children
        proc.unref();

        sendAgentUpdate(agent);
        agents.push(agent);

        // Small stagger to avoid overwhelming the system
        await new Promise((r) => setTimeout(r, 300));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        agent.status = 'error';
        addLog('error', `Failed to launch ${agentName}: ${message}`);
        anyFailed = true;
        agents.push(agent);
      }
    }
  }

  if (promptSuffix) {
    addLog('info', `Initial prompt passed as argument to each agent command.`);
  }

  addLog(anyFailed ? 'warn' : 'success', `Launch complete. ${agents.filter((a) => a.status === 'running').length} agents running.`);

  return { success: !anyFailed, agents, logs };
});

// Stop all running agents
ipcMain.handle('stop-all-agents', async (): Promise<{ stopped: number }> => {
  let stopped = 0;
  for (const [id, proc] of runningProcesses.entries()) {
    try {
      if (proc.pid) {
        if (process.platform !== 'win32') {
          // Kill the entire process group (terminal + child)
          try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e) { proc.kill(); }
        } else {
          proc.kill();
        }
        stopped++;
      }
      const agent = runningAgents.get(id);
      if (agent) {
        agent.status = 'stopped';
        runningAgents.set(id, agent);
        sendAgentUpdate(agent);
      }
    } catch (_e) {
      // Already gone
    }
    runningProcesses.delete(id);
  }
  log('info', `Stopped all agents. (${stopped} terminated)`);
  return { stopped };
});

// Get list of currently tracked agents
ipcMain.handle('get-running-agents', async (): Promise<RunningAgent[]> => {
  return Array.from(runningAgents.values());
});

// Open folder picker dialog
ipcMain.handle('pick-directory', async (): Promise<string | null> => {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select Project Directory',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
