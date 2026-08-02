# Agent Launcher (Tauri v2 ADE)

**Read `context.md` first.** It holds the full project context: what this app is, how a
voice turn flows, the Groq model setup, and the constraints. This file is the quick
project map plus operational instructions.

## Project description

Voice-driven agent development environment for Windows. Hold the talk key, speak, and a
Groq-hosted orchestrator model launches named coding agents (Claude Code, Codex, Gemini)
in PTY terminal cards on a canvas, routes prompts to them, reads their output, opens a
browser preview, and switches workspaces. Replies are spoken via Piper or Windows SAPI.
This D: copy is the Tauri v2 + Rust rewrite; the old Electron app on C: is being retired.

## AI models: Groq only

All three models run on Groq's free tier with one API key. No local Ollama, no local
whisper; local inference on this CPU took minutes per reply and must not come back.

- Orchestrator: `llama-3.3-70b-versatile` (default), `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, or `llama-3.1-8b-instant`, tool calling via `/openai/v1/chat/completions`. Free tier TPM is tight (versatile 12k, instant 6k, gpt-oss-120b 8k); `groq_chat` retries 429s that clear within 15s.
- Voice to text: `whisper-large-v3-turbo` via `/openai/v1/audio/transcriptions`.
- Key: `GROQ_API_KEY` env var, else `groq.json` in `%APPDATA%\com.agentterminals.ade`. Settings panel can save it (`groq_key_set`). Never commit the key.

Claude Code only. There is no Codex, Gemini, or any other agent type, and no HTTP anywhere
in the running app (the old localhost control server is not started).

## Main files

- Frontend (Vite + React + TS, `src/`): `lib/orchestrator.ts` (brain, tools, Groq loop, launchAgents), `lib/voice.ts` (talk key, barge in), `lib/store.ts` (zustand, workspaces, accounts, presets, dock), `lib/types.ts` (settings, presets, device presets, dock), `lib/backend.ts` (invoke bridge), `components/App.tsx` (topbar, event wiring), `components/OrchestratorBar.tsx`, `components/TerminalCard.tsx`, `components/AccountSwitcher.tsx` (top bar, per workspace), `components/DockPanel.tsx` (docked Browser and Editor), `components/Canvas.tsx` (empty state, quick launch presets), `components/SettingsPanel.tsx`.
- Backend (Rust, `src-tauri/src/`): `groq.rs` (chat, transcription, key), `speech.rs` (cpal mic, TTS with barge in), `pty.rs` (agent terminals, done detection), `accounts.rs` (Claude account folders), `files.rs` (editor file read, write, list dir, open external), `control.rs` (legacy HTTP API, no longer started), `ollama.rs` (legacy, unused).

## Dev & build

```powershell
$env:RUSTUP_HOME='D:\rust\rustup'; $env:CARGO_HOME='D:\rust\cargo'; $env:Path="D:\rust\cargo\bin;$env:Path"
$env:CARGO_TARGET_DIR='D:\dev\agent-terminals\build-cache\agent-launcher-v2'
npm run tauri dev                  # dev app (vite + cargo)
npm run tauri build -- --no-bundle # production exe in $env:CARGO_TARGET_DIR\release
npm run tauri build                # same plus NSIS installer in that release\bundle
```

Never build the production exe with raw `cargo build --release`: that skips the
`custom-protocol` feature, so the exe tries to load the Vite dev server
(`localhost:5173`) and shows "localhost refused to connect" when opened as an app.
Always go through `npm run tauri build`.

Source lives on C: (`C:\dev\agent-terminals\agent-launcher-v2`). Toolchain and the ~9 GB Rust
build cache live on D: (`D:\rust\cargo`, `D:\rust\rustup`,
`D:\dev\agent-terminals\build-cache\agent-launcher-v2`), because C: has little free space.
Always set `CARGO_TARGET_DIR` before building, then install the finished build over the
per-user app at `%LOCALAPPDATA%\Agent Launcher ADE`, which is what the Start Menu shortcut
opens (verified 2026-07-27; `src-tauri\target\release` no longer exists on C:).

### Linux (.deb)

Tauri cannot cross compile Windows to Linux, so the `.deb` and `.AppImage` are built by
`.github/workflows/linux-build.yml` on a free `ubuntu-22.04` runner (the repo is public, so
CI is free). Push a `v*` tag to publish them to a GitHub Release, or run the workflow
manually and download the artifact. On an Ubuntu machine, `npm run tauri:linux` does the
same locally.

Platform differences in the Rust backend, all behind `cfg(windows)`:

- `pty.rs` spawns `$SHELL -l` instead of `cmd.exe`, merges PATH with `:` plus `~/.local/bin`
  and friends, and kills children with `pkill -P` instead of `taskkill /T`.
- A `cwd` that does not exist (a Windows path in a synced setting) falls back to `$HOME`.
- `speech.rs` plays WAVs with `paplay`/`aplay` and falls back to `espeak-ng`/`spd-say`
  instead of SAPI. Piper defaults to `~/.local/share/piper`.
- `update.rs` is Windows only. On Linux the Update button tells the user to install the
  newest `.deb`; there is no in place self update.
- ConPTY is Windows only and is not needed on Linux, where portable-pty uses real ptys.

**ConPTY sideload (terminal scrollback depends on it).** `src-tauri\conpty\` holds a modern
`conpty.dll` + `OpenConsole.exe` (from the Windows Terminal project, via node-pty). They must
sit in the same folder as `agent-launcher.exe` wherever it runs: portable-pty prefers a
sideloaded conpty.dll over the Windows 10 inbox one, and the inbox conhost silently drops
lines that scroll off during fast output, so xterm scrollback stays empty and cards cannot
scroll up. If the exe is copied somewhere new, copy both files next to it.

TTS: neural Piper if present at `D:\ai\piper\piper\piper.exe` + `en_US-amy-medium.onnx` (override with
`AGENT_PIPER_EXE` / `AGENT_PIPER_MODEL`), otherwise Windows SAPI (Zira).

## Seeing changes from the Windows search bar (do this after every change)

The Start Menu entry **Agent Launcher ADE** (what you type into Windows search) launches the
installed per-user app: `%LOCALAPPDATA%\Agent Launcher ADE\agent-launcher.exe`. That binary
is a snapshot, so source edits stay invisible until it is rebuilt and reinstalled. **After
finishing a change (or a batch of changes), always ship it** so Rim sees the new version from
search:

```powershell
$env:RUSTUP_HOME='D:\rust\rustup'; $env:CARGO_HOME='D:\rust\cargo'; $env:Path="D:\rust\cargo\bin;$env:Path"
$env:CARGO_TARGET_DIR='D:\dev\agent-terminals\build-cache\agent-launcher-v2'
npm run tauri build
```

The build is safe to run while the app is open (output goes to the D: cache). Once it
finishes, the in-app **Update available** button does the rest: it copies the freshly built
`agent-launcher.exe` plus the conpty sidecars over the installed app and restarts it, logging
every step to `debug.log`. It no longer runs the NSIS installer on the happy path, because
`/S` silently aborted and left the app on the old build with nothing written anywhere.

To put a build in place without closing a running app, stage it instead. Windows blocks
overwriting a running exe but allows renaming it, so the live process keeps its old image and
the next launch picks up the new one:

```powershell
$dir = "$env:LOCALAPPDATA\Agent Launcher ADE"
Copy-Item 'D:\dev\agent-terminals\build-cache\agent-launcher-v2\release\agent-launcher.exe' `
  "$dir\agent-launcher.new.exe" -Force
Move-Item "$dir\agent-launcher.exe" "$dir\agent-launcher.old.exe" -Force
Move-Item "$dir\agent-launcher.new.exe" "$dir\agent-launcher.exe" -Force
```

**Never close a running Agent Launcher without asking Rim first** — it may be hosting live
agents, including the session doing the work. Stage the build and let Rim restart on his own
schedule. `setup-shortcut.ps1` re-creates the Start Menu entry. Never `cargo build --release`
(see the warning above).

Summary: edit, build with `CARGO_TARGET_DIR` set, then either press Update in the app or stage
the exe with the rename swap. Copy-Item preserves the source timestamp, which is exactly what
`update_check` compares, so the button reports "Up to date" straight after an update.

## No HTTP control API

The old localhost control server (`control.rs`) is intentionally not started, and agents
are no longer primed to spawn other agents. Nothing in the app opens an HTTP port and no
HTTP text is ever shown to the user or handed to a terminal. `control.rs` stays in the tree
but is dead code; do not re-enable it.

## Browser and Editor dock

`DockPanel.tsx` is a right side docked panel with Browser and Editor tabs, toggled from the
top bar or the orchestrator `open_browser` tool. Browser is an iframe with an address bar,
back, forward, reload, device presets (`DEVICE_PRESETS` in types.ts), and an Open in system
browser fallback for sites that refuse framing. Editor lists a folder (`files.rs list_dir`),
opens a file (`read_text_file`), edits it in a textarea, and saves (`write_text_file`,
also Ctrl+S).

## Conventions

- No dashes in visible UI copy. No new code comments.
- Design tokens and rules: `DESIGN.md`, product context: `PRODUCT.md`. Follow them for UI work.
- Per-workspace Claude accounts: non default workspaces get their own `CLAUDE_CONFIG_DIR`
  seeded from the global `~/.claude.json` and credentials (see `ensure_workspace_config`).
