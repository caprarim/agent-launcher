# Agent Launcher on Linux (Tauri v2)

The Linux build is a **Tauri v2** shell around the same React UI the Windows
Electron build uses. Everything the Electron main process did — spawning PTYs,
the localhost control API, Claude account switching, the file watcher, AI tab
naming — is reimplemented in Rust under `src-tauri/`.

Target distro: **Ubuntu** (built on 22.04 so the artifacts also run on 24.04).

## Install

Download either bundle from the repository's
[latest release](https://github.com/caprarim/agent-launcher/releases/latest):

```bash
# Debian package (adds a desktop entry and an app menu icon)
sudo dpkg -i Agent\ Launcher_2.1.0_amd64.deb
sudo apt-get -f install          # only if dpkg reports missing dependencies

# or the portable AppImage
chmod +x Agent\ Launcher_2.1.0_amd64.AppImage
./Agent\ Launcher_2.1.0_amd64.AppImage
```

Runtime dependencies (already present on a normal Ubuntu desktop):
`libwebkit2gtk-4.1-0`, `libgtk-3-0`.

The agent CLIs you want to launch must be on your `PATH` — `claude`, `codex`,
`gemini`, `cursor-agent`, `grok`.

## Build from source

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf build-essential curl wget file
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

npm install --ignore-scripts     # skips the Windows-only node-pty rebuild
npm run build:linux              # renderer + deb + AppImage
```

Bundles land in `src-tauri/target/release/bundle/{deb,appimage}/`.

`npm run tauri:dev` runs it live.

CI does the same thing in `.github/workflows/build-linux.yml`; run it from the
Actions tab (or push a `v*` tag) and it attaches both bundles to the release.

## What changed versus the Electron build

| Area | Electron (Windows) | Tauri v2 (Linux) |
|---|---|---|
| Terminals | `node-pty` + bundled conpty.dll | `portable-pty` (a real Unix pty) |
| Renderer transport | `ipcRenderer` / `contextBridge` | `invoke` + `listen` |
| Browser pane | `<webview>` tag | `<iframe>` (WebKitGTK has no webview tag) |
| Default project path | `C:\dev` | your home directory |
| Shell | `cmd.exe` | `$SHELL`, falling back to `/bin/bash` |
| Config location | `%APPDATA%\agent-terminals` | `~/.config/agent-terminals` |

The React components are untouched: `src/renderer/tauri/bridge.ts` reinstalls the
exact `window.electronAPI` surface on top of Tauri, so one source tree builds
both shells.

Two behaviours worth knowing about on Linux:

- **The browser pane is an iframe.** Sites that send `X-Frame-Options: DENY`
  (Google, GitHub, X) refuse to render inside it. Local dev servers —
  `localhost:3000`, `127.0.0.1:5173` — which is what the viewport presets exist
  for, work normally. Back/Forward use a history stack the pane keeps itself,
  because an embedder cannot read a cross-origin frame's history.
- **Multiple instances share one WebKitGTK data directory.** The control API
  still walks ports (4575, 4576, ...) per instance, but the Electron build's
  numbered `instance-N` userData dirs have no equivalent here.

## Control API

Unchanged, and still loopback-only. From inside a launcher terminal:

```bash
curl -s "localhost:$AGENT_LAUNCHER_PORT/agents"

curl -s -X POST "localhost:$AGENT_LAUNCHER_PORT/orchestrate" \
  -H 'Content-Type: application/json' \
  -d '{"goal":"Build auth","tasks":["routes","middleware","UI"],"type":"claude"}'
```

See [CLAUDE.md](CLAUDE.md) for the full endpoint list.

## Troubleshooting

**Blank window.** Run the AppImage from a terminal and check for a WebKit error.
`WEBKIT_DISABLE_COMPOSITING_MODE=1` fixes it on some GPU/driver combinations:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./Agent\ Launcher_2.1.0_amd64.AppImage
```

**Terminals open but the agent CLI is "not found".** The PTY inherits the
launcher's environment. Launching from an app menu icon means a login shell
never ran, so a `PATH` exported in `~/.bashrc` is missing — start the app from a
terminal once to confirm, then move the `PATH` export into `~/.profile`.

**`API :4575` badge shows a different port.** Another launcher instance owns
4575. That is expected; agents inside a terminal should use
`$AGENT_LAUNCHER_PORT`, never a hardcoded port.

**AI tab naming does nothing.** It needs a Groq key: either `GROQ_API_KEY` in the
environment, or `{"groqApiKey":"..."}` in
`~/.config/agent-terminals/ai-config.json`. Without one the tabs fall back to the
offline heuristic names, and the app logs that at startup.
