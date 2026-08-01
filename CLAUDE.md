# Agent Launcher — Control API

This app exposes a **localhost HTTP control API** so an agent (e.g. you, Claude Code,
running inside one of the terminals) can open new agent terminals and type prompts into
them — no screen-coordinate mouse clicking required.

Base URL: `http://127.0.0.1:4575` (override with the `AGENT_LAUNCHER_PORT` env var).
It is bound to loopback only and is up whenever the app is running.

Multiple launcher instances can run side by side: the first one binds 4575 and
each extra instance takes the next free port (4576, 4577, ...). Every terminal's
environment carries `AGENT_LAUNCHER_PORT` set to ITS launcher's actual port — so
from inside a terminal, always use `http://127.0.0.1:$env:AGENT_LAUNCHER_PORT`
(or `$AGENT_LAUNCHER_PORT` in bash) rather than hardcoding 4575. The topbar
badge (e.g. `API :4576`) shows the running instance's port.

## Endpoints

| Method & path | What it does |
|---|---|
| `GET /agents` | List all terminals: `id`, `name`, `type`, `status`, `cwd`. |
| `POST /agents` | Add a terminal (the "Add Claude" click). Body: `{ "type": "claude" }` (or `codex`/`gemini`). Returns the new agent; only resolves once its terminal PTY is live. Capped at **5 agents**. |
| `POST /orchestrate` | **Fast path.** Spawn a whole team + assign tasks in ONE call. Body: `{ "goal": "...", "tasks": ["t1","t2",...], "type": "claude" }`. Spawns all agents in parallel, detects readiness automatically (no fixed sleep), then injects each agent's task plus shared cross-agent context. Capped at 5. |
| `POST /agents/:id/input` | Type into a terminal. Body: `{ "text": "...", "submit": true }`. `submit` (default true) presses Enter. |
| `GET /agents/:id/output` | Read recent output (ANSI-stripped). Query: `?tail=4000` (last N chars), `?raw=1` (keep ANSI). |
| `DELETE /agents/:id` | Close a terminal. |

## Example (PowerShell)

```powershell
# 1) Open a new Claude terminal and capture its id
$a = Invoke-RestMethod -Method Post http://127.0.0.1:4575/agents -ContentType application/json -Body '{"type":"claude"}'
$id = $a.agent.id

# 2) Give the agent a few seconds to finish booting, then send a prompt
Start-Sleep -Seconds 6
Invoke-RestMethod -Method Post "http://127.0.0.1:4575/agents/$id/input" -ContentType application/json -Body '{"text":"write a hello world in python","submit":true}'

# 3) Read what it printed back
Invoke-RestMethod "http://127.0.0.1:4575/agents/$id/output?tail=4000"
```

## Example (curl / bash)

```bash
id=$(curl -s -X POST localhost:4575/agents -d '{"type":"claude"}' | python -c 'import sys,json;print(json.load(sys.stdin)["agent"]["id"])')
sleep 6
curl -s -X POST localhost:4575/agents/$id/input -d '{"text":"write a hello world in python","submit":true}'
curl -s "localhost:4575/agents/$id/output?tail=4000"
```

## AI Agent Orchestration (How to fulfill user requests)

**Preferred: use `POST /orchestrate`.** It replaces the old multi-call + 6-second-sleep
dance with a single request that spawns the whole team in parallel, waits for each
agent to actually be ready (marker/settle detection instead of a blind sleep), and
injects every task at once — plus shared "you are Agent N of M, the others are doing X"
context so the agents coordinate.

```powershell
# Spawn 4 agents to build auth, each with its own task + shared context, in one shot.
Invoke-RestMethod -Method Post http://127.0.0.1:4575/orchestrate -ContentType application/json -Body (@{
  goal  = "Build the authentication system"
  type  = "claude"
  tasks = @(
    "Build the login + signup REST endpoints in src/auth/routes.ts",
    "Build the JWT/session middleware in src/auth/middleware.ts",
    "Build the login/signup React UI in src/components/Auth.tsx",
    "Write integration tests for the auth flow in tests/auth.test.ts"
  )
} | ConvertTo-Json)
```

One `tasks` entry = one agent. Total agents are capped at **5** (existing + new). Extra
tasks beyond the cap come back in `dropped`.

### Legacy manual protocol (only if you need per-agent control)

1.  **Spawn Agents:** Loop N times, calling `POST /agents` with the requested type.
2.  **Collect IDs:** Store the `id` returned for each new agent.
3.  **Wait for Boot:** poll `GET /agents/:id/output` until the CLI prompt appears
    (the old fixed 6-second sleep is no longer needed — `/orchestrate` does this for you).
4.  **Send Task:** For each ID, call `POST /agents/:id/input` with `{"submit": true}`.
5.  **Confirm:** Tell the user the agents are launched and tasked.

### Example Orchestration (Node.js/fetch)
```javascript
const spawnAndTask = async (count, task) => {
  for (let i = 0; i < count; i++) {
    const res = await fetch('http://127.0.0.1:4575/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'claude' })
    });
    const { agent } = await res.json();
    
    setTimeout(async () => {
      await fetch(`http://127.0.0.1:4575/agents/${agent.id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: task, submit: true })
      });
    }, 6000);
  }
};
```

## Preflight & Recovery (API "down" / connection refused)

If `http://127.0.0.1:4575` refuses connections, the app may be running while its
control server failed to bind. Diagnose and recover before giving up:

1. **Is anything on 4575?** `Get-NetTCPConnection -State Listen -LocalPort 4575`.
   If nothing is listed, the API is not bound.
2. **Is the app running?** `Get-Process "Agent Terminals"`. If yes but step 1 is
   empty, the running instance failed to bind (historically: a lingering process
   briefly held the port at startup and the server died silently with no retry).
3. **Recover:** relaunch the exe — a fresh instance rebinds 4575 and logs
   `[control] Agent Launcher control API on http://127.0.0.1:4575`. The single
   instance lock now focuses the existing window instead of spawning a rival.

Hardened in source so this should not recur: `controlServer.ts` retries on
`EADDRINUSE` (10× / 1s) instead of failing silently, and `main.ts` enforces a
single instance via `app.requestSingleInstanceLock()`. After editing either,
run `npm run package` so the shipped binary carries the fix.

## Packaging recovery (app won't launch)

- If launch shows **"A JavaScript error occurred in the main process"**, the `app.asar` is broken. Rebuild node-pty for Electron (`npm run rebuild`, ABI 119), then repack ensuring `app.asar` contains `package.json` + `node_modules/node-pty` unpacked.
- If error is **"...package.json: Unexpected token...not valid JSON"**, the file has a UTF-8 BOM — rewrite it BOM-free.

## Linux (Tauri v2) build

The Ubuntu build is a Tauri v2 shell over the same React UI — see
[LINUX.md](LINUX.md). The control API above is byte-for-byte the same there: the
Rust server in `src-tauri/src/control.rs` serves the identical routes, agent cap
and readiness detection, so every example on this page works unchanged.

Two Linux-only details when recovering the API:

- `Get-NetTCPConnection` has no meaning; use `ss -ltnp | grep 4575`.
- There is no single-instance lock. Extra launchers simply take the next free
  port, so several may be listening at once — `$AGENT_LAUNCHER_PORT` inside a
  terminal is the only reliable way to reach the one that owns it.

## Notes
- After `POST /agents`, the new terminal auto-runs the agent CLI (e.g.
  `claude --dangerously-skip-permissions`). Wait a few seconds for it to finish
  starting before sending a prompt.
- To send a prompt without submitting (e.g. multi-step typing), use `"submit": false`,
  then later send `{ "text": "", "submit": true }` to press Enter.
