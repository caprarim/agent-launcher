# Agent Launcher

A clean desktop app that lets you spawn multiple AI coding agents (Codex, Claude, Gemini, Cursor, Grok) with one click — each in its own embedded terminal.

Two shells build from this one source tree:

| Platform | Shell | Build |
|---|---|---|
| Windows | Electron | `npm run package` |
| Linux (Ubuntu) | **Tauri v2** | `npm run build:linux` |

Linux users: see **[LINUX.md](LINUX.md)** for install, build, and the handful of
platform differences. The React UI is identical — `src/renderer/tauri/bridge.ts`
reinstalls the same `window.electronAPI` surface on top of Tauri's `invoke` and
`listen`, and `src-tauri/` holds the Rust port of the Electron main process.

## Screenshot

```
┌────────────────────────────────────────────────────────────┐
│ ⚡ Agent Launcher                                           │
├──────────────────────┬─────────────────────────────────────┤
│ ◈ Codex  [1] [codex] │  Activity Log                       │
│ ◆ Claude [2] [claude]│  ✓ Launching codex-agent-1...       │
│ ◇ Gemini [1] [gemini]│  ✓ Started PID: 12345               │
│                      │  ✓ Launching claude-agent-1...      │
│ 📁 Project Path      │  ✓ Started PID: 12346               │
│ 💬 Initial Prompt    │                                     │
│                      │  codex-agent-1 ● claude-agent-1 ●  │
│ [⚡ Launch 4 Agents] │  claude-agent-2 ● gemini-agent-1 ● │
│ [⛔ Stop All]        │                                     │
└──────────────────────┴─────────────────────────────────────┘
```

## Requirements

- **Node.js** 18 or higher
- **npm** 9 or higher
- A terminal emulator installed on your system:
  - **macOS**: Terminal.app (built-in) — used automatically
  - **Linux**: gnome-terminal, xfce4-terminal, konsole, xterm, alacritty, or kitty
  - **Windows**: cmd.exe (built-in) — used automatically
- The AI agent CLIs you want to use must be installed and on your PATH:
  - `codex` — [OpenAI Codex CLI](https://github.com/openai/codex)
  - `claude` — [Anthropic Claude CLI](https://github.com/anthropics/claude-code)
  - `gemini` — [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)

## Installation

```bash
git clone <this-repo>
cd agent-launcher
npm install
```

## Running in Development

```bash
npm run dev
```

This builds both the main process and renderer, then launches the Electron app.

> **Note:** Two webpack watchers start first (main + renderer). The Electron window opens once the initial build is complete (usually ~10 seconds).

## Building for Production

```bash
npm run build   # compile TypeScript + bundle
npm start       # build then launch
```

## Packaging (distributable binary)

```bash
npm run package
```

The output binary is placed in the `release/` folder.

---

## How to Use

### 1. Set Agent Counts

Each agent row (Codex, Claude, Gemini) has a **Count** field. Set the number of terminal windows you want for each type.

- Total agents cannot exceed **10** (configurable in `src/renderer/App.tsx` via `MAX_AGENTS`).
- Set count to 0 to skip that agent type.

### 2. Customize Commands

Each row has a **Command** field pre-filled with the default CLI name:
- Codex → `codex`
- Claude → `claude`
- Gemini → `gemini`

You can use any shell command here, for example:
```
claude --model claude-opus-4-7
codex --approval-mode full-auto
gemini --model gemini-2.5-pro
```

### 3. Set Project Path (optional)

Type or browse to a directory. Agents launch with `cd` into that folder first.
Leave it empty to use the directory where Agent Launcher was started.

### 4. Initial Prompt (optional)

Text entered here is appended to each agent command as a quoted argument:
```
claude "Write tests for the auth module"
```

This works best when the agent CLI accepts a prompt as its first positional argument (all three supported CLIs do).

### 5. Launch Agents

Click **⚡ Launch Agents**. A confirmation dialog shows:
- How many of each agent
- Working directory
- Initial prompt (if set)

Click **Launch** to confirm. Each agent opens in its own terminal window.

### 6. Stop All Agents

Click **⛔ Stop All Agents** to send SIGTERM to all tracked terminal processes.

> **Note:** The terminal windows themselves may remain open after the process exits; close them manually.

---

## Agent Naming

Agents are named sequentially:
```
codex-agent-1, codex-agent-2, codex-agent-3
claude-agent-1, claude-agent-2
gemini-agent-1
```

The terminal window title is set to the agent name.

---

## Architecture

```
agent-launcher/
├── src/
│   ├── main/
│   │   ├── main.ts       # Electron main process: spawns terminals, IPC handlers
│   │   └── preload.ts    # Context bridge: exposes safe API to renderer
│   ├── renderer/
│   │   ├── index.html    # HTML shell
│   │   ├── index.tsx     # React entry point
│   │   ├── App.tsx       # Main dashboard component
│   │   ├── styles.css    # Dark mode CSS
│   │   └── components/
│   │       ├── AgentCard.tsx     # Per-agent config row
│   │       ├── LogPanel.tsx      # Live log display
│   │       └── ConfirmModal.tsx  # Launch confirmation dialog
│   └── shared/
│       └── types.ts      # TypeScript interfaces shared by main + renderer
├── webpack.main.config.js
├── webpack.renderer.config.js
├── tsconfig.json
└── package.json
```

**IPC channels:**
| Channel | Direction | Description |
|---|---|---|
| `launch-agents` | renderer → main | Spawn terminal windows |
| `stop-all-agents` | renderer → main | Kill all tracked processes |
| `get-running-agents` | renderer → main | List current agents |
| `pick-directory` | renderer → main | Open folder picker dialog |
| `log-entry` | main → renderer | Push log message |
| `agent-update` | main → renderer | Agent status change |

---

## Troubleshooting

**"Command not found" errors**
Make sure the CLI is on your PATH. Test in a regular terminal first:
```bash
which codex && codex --version
which claude && claude --version
which gemini && gemini --version
```

**No terminal window opens on Linux**
Install a supported terminal emulator:
```bash
sudo apt install xterm        # minimal, always works
sudo apt install gnome-terminal
```

**App won't start after `npm run dev`**
Make sure both webpack builds finish before Electron opens. The `wait-on` package handles this automatically.

**Prompt not sent to agent**
Some agent CLIs do not accept a positional argument for the prompt. In that case, leave the Initial Prompt field empty and type your prompt directly in each terminal window after it opens.
