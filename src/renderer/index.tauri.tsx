import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { installTauriBridge, loadPlatformInfo } from './tauri/bridge';

// Entry point for the Linux (Tauri v2) build.
//
// App and its children read `window.electronAPI` while their modules evaluate
// (the project path box defaults from it), so the bridge has to be installed
// BEFORE any of them load — hence the dynamic import below rather than a plain
// top-level `import App from './App'`.
async function main(): Promise<void> {
  const info = await loadPlatformInfo().catch((err) => {
    console.error('[bridge] could not read platform info:', err);
    return {
      platform: 'linux',
      homeDir: '',
      defaultProjectPath: '',
      winBuildNumber: 0,
    };
  });

  installTauriBridge(info);

  const { default: App } = await import('./App');
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  root.render(<App />);
}

void main();
