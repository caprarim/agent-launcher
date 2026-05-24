import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as pty from 'node-pty';
import { PtyCreateOptions, PtyCreateResult } from '../shared/types';

// Map of live PTY processes keyed by agent id
const ptyMap = new Map<string, pty.IPty>();

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Kill every PTY when the window closes
    for (const [id, proc] of ptyMap) {
      try { proc.kill(); } catch (_e) {}
      ptyMap.delete(id);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
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
ipcMain.handle('pty:create', (_event, opts: PtyCreateOptions): PtyCreateResult => {
  try {
    // Choose shell per platform
    const shell = process.platform === 'win32'
      ? 'cmd.exe'
      : (process.env.SHELL || '/bin/bash');

    // Spawn an interactive shell, then immediately type the agent command
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd || os.homedir(),
      env: process.env as { [key: string]: string },
    });

    ptyMap.set(opts.id, proc);

    // Relay PTY output to the renderer
    proc.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { id: opts.id, data });
      }
    });

    proc.onExit(({ exitCode }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { id: opts.id, exitCode });
      }
      ptyMap.delete(opts.id);
    });

    // Type the agent command automatically after a short delay (shell needs to settle)
    const cmd = process.platform === 'win32'
      ? opts.command + '\r'
      : opts.command + '\n';
    setTimeout(() => {
      if (ptyMap.has(opts.id)) proc.write(cmd);
    }, 200);

    return { success: true, pid: proc.pid };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
});

// ── PTY: write (fire-and-forget, no response needed) ─────────────────────────
ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => {
  ptyMap.get(id)?.write(data);
});

// ── PTY: resize ───────────────────────────────────────────────────────────────
ipcMain.on('pty:resize', (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  try { ptyMap.get(id)?.resize(cols, rows); } catch (_e) {}
});

// ── PTY: kill ─────────────────────────────────────────────────────────────────
ipcMain.handle('pty:kill', (_event, id: string): void => {
  const proc = ptyMap.get(id);
  if (proc) {
    try { proc.kill(); } catch (_e) {}
    ptyMap.delete(id);
  }
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
