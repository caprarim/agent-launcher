# Progress Log

## 2026-06-20 — Fast team orchestration

- Added `POST /orchestrate` to the control API (`src/main/controlServer.ts`). One call
  spawns a whole team of agents in parallel, waits for each to be ready, and injects
  every task — replacing the old "spawn one, sleep 6s, send task, repeat" flow.
- **Smart readiness detection** (`waitUntilReady`): polls captured terminal output and
  returns as soon as a known CLI "ready" marker appears or output settles (~2–3s),
  instead of a blind fixed 6-second sleep. Runs for all agents in parallel.
- **Shared cross-agent context** (`buildTeamPrompt`): each agent is told it is "Agent N
  of M", the shared goal, and a roster of what every other agent is doing — composed as
  a single line so a raw PTY doesn't submit it early on newlines.
- **Hard cap of 5 agents** enforced on both `POST /agents` and `POST /orchestrate`.
- Bumped version to **1.1.0** and ran `npm run package` → `release\Agent Terminals Setup 1.1.0.exe`.
- Updated `CLAUDE.md` to document `/orchestrate` as the preferred path.
