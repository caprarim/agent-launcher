# Agent Launcher — Context

## What this is

Agent Launcher (also called Agent Launcher ADE, "Tauri V2") is Rim's voice-driven agent
development environment for Windows. You hold a talk key (default Ctrl+Alt+O), speak a
command like "launch three claude agents and have them build the login page", and an
LLM orchestrator launches real coding-agent CLIs (Claude Code, Codex, Gemini) inside
draggable terminal cards on a starfield canvas. The orchestrator can also prompt agents,
read their output back to you, open a browser preview, switch workspaces, and go to sleep.
Replies are spoken out loud (Piper neural TTS if installed, Windows SAPI otherwise).

This D:\dev\agent-terminals\agent-launcher copy is the current Tauri v2 + Rust rewrite.
The older Electron version lives at C:\Dev\agent-terminals\agent-launcher and is being
phased out. Same git lineage, completely different runtime; do not mix them up.

## AI models (all Groq cloud, free tier, one API key)

Everything AI runs on Groq. There is no local Ollama or local whisper in the loop anymore;
the old local path (qwen3:4b / qwen2.5 on CPU + whisper base.en) took minutes per reply
and was replaced in July 2026.

1. Orchestrator: `llama-3.3-70b-versatile` (default) via Groq chat completions, tool calling.
2. Alternatives selectable in settings: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.1-8b-instant`. The gpt-oss models have bigger daily budgets, useful when the llamas are rate limited.
3. Voice to text: `whisper-large-v3-turbo` via Groq audio transcriptions, same model Code Voice uses.

The API key is read from the `GROQ_API_KEY` env var, else from `groq.json`
(`{"apiKey":"..."}`) in the Tauri app config dir
(`%APPDATA%\com.agentterminals.ade`). Settings has a paste-and-save field
(`groq_key_set`). Never commit the key to the repo.

## How a voice turn flows

1. `voice.ts` talk key press → barge-in first: `speak_stop` cuts any current TTS and,
   if the orchestrator was thinking or speaking, `interrupt()` cancels the in flight turn.
   Then `voice_start` (Rust, cpal) records the mic.
2. Release → `voice_stop` resamples to 16k mono WAV → `groq::transcribe_wav` → text.
3. `orchestrator.ts runTurn(text)` → `groq_chat` with system prompt + tool schema. The
   prompt keeps replies to one or two spoken sentences with no greetings or jargon.
4. Tool calls are executed in `execTool` (launch agents, prompt them, read output,
   preview, workspaces, sleep), up to 5 rounds, then the final reply is shown and spoken.
5. Typed input in the bottom bar goes straight to `runTurn`, same path minus the mic.

TTS emits a `tts-state {speaking}` event; the bar shows a speaking orb and a Stop button
during both thinking and speaking, so a turn can be cut from the UI as well as the mic.

## Main files

- `src/lib/orchestrator.ts` — orchestrator brain: system prompt, tool schema, tool execution, Groq chat loop, interrupt.
- `src/lib/voice.ts` — talk key press/release handling.
- `src/lib/store.ts` — zustand store: workspaces, agents, accounts, settings (persisted as `agent-launcher-v3`). Card layout state (expand, minimize, relaunch epoch, tile) lives here.
- `src/lib/types.ts` — shared types, `DEFAULT_SETTINGS`, `GROQ_CHAT_MODELS`, `GROQ_VOICE_MODEL`.
- `src/lib/backend.ts` — typed `invoke` bridge to Rust.
- `src/lib/naming.ts` / `names.ts` — task label heuristics and the agent name pool.
- `src/components/App.tsx` — event wiring, topbar (add agent, add preview, tile), canvas shell.
- `src/components/OrchestratorBar.tsx` — bottom bar: workspaces, mic, account switcher, model chip, stop button.
- `src/components/TerminalCard.tsx` — agent card with relaunch, minimize, expand, close; remounts on relaunch keyed by epoch.
- `src/components/PreviewCard.tsx`, `Canvas.tsx`, `SettingsPanel.tsx` — UI. Settings manages Claude accounts.
- `src-tauri/src/groq.rs` — Groq chat + transcription + API key storage and cancel.
- `src-tauri/src/speech.rs` — mic capture (cpal), WAV writing, Piper/SAPI TTS queue with barge-in (`speak_stop`).
- `src-tauri/src/pty.rs` — portable-pty sessions; `activity_monitor` emits `agent-done` with a cleaned output tail after about five seconds of an agent going quiet. That event is only a candidate, never a verdict: the renderer decides.
- `src-tauri/src/accounts.rs` — Claude account folders under the app config dir: `list_accounts`, `create_account`. A workspace account sets `CLAUDE_CONFIG_DIR` for its agents.
- `src-tauri/src/control.rs` — localhost HTTP control API (port 4575+) so agents can spawn agents.
- `src-tauri/src/ollama.rs` — legacy local model proxy, kept but no longer called by the UI.

## LOCKED: how prompting and done detection work (verified 2026-07-27, never change this)

Agent readiness and done announcements read the live xterm screen via `bindScreen`/`readScreen`
(backend.ts, registered in TerminalCard), never the raw pty stream, because stripped ANSI
frames leave stale text like ">" and "esc to interrupt" in the stream forever. `probeAgent`
says ready when the screen shows a READY_MARKER. Obvious prompt or launch requests force
`tool_choice`; text-leaked tool calls get salvaged; `groq_chat` retries short 429 waits. Every
decision logs to `%APPDATA%\com.agentterminals.ade\debug.log`. Read that log before touching
any of this.

Terminal silence is not "done". `activity_monitor` firing after a quiet gap is only a
candidate; `src/lib/screen.ts` holds the verdict and every rule lives there, not inline in
App.tsx. Four gates must all pass before an announcement:

1. The agent is active (`working`, `asking`, or `running` with `worked`). A `done` agent is
   never re-announced, which is what produced 11 "sage is done" announcements in 7 minutes
   on 2026-07-27.
2. `isBusyScreen` is false for the bottom 8 rows. Rows are box-char stripped and joined with
   spaces before matching, so a hint wrapped across two rows in a narrow card still matches;
   the old raw `/esc to interrupt/` on the un-joined screen missed every wrapped frame and
   logged `stillWorking=false` while the agent was clearly thinking. A spinner word ending in
   `…` next to an elapsed counter also counts as busy, for frames with no interrupt hint.
3. `isIdleScreen` is true: the Claude Code input box and its footer hint are on screen.
4. The same two checks still pass `CONFIRM_IDLE_MS` (2.6s) later, re-read live. This is what
   kills a mid-task pause: a thinking agent has repainted its spinner by then.

Only 8 bottom rows are searched for busy markers so stale spinner frames left in scrollback
cannot pin an agent as busy forever, and "ctrl+o to expand" is deliberately not a busy marker
because collapsed tool output keeps it on screen while idle.

Layered on top of that same idle detection (not a change to it): when an agent goes idle,
App.tsx `detectAsking` inspects the live screen for a question waiting on the user, a Claude
Code selection prompt (the `❯` cursor with numbered options, or a choice phrase with several
numbered rows) or a trailing `?` line once the idle input box and `for shortcuts` /
`bypass permissions` hints are filtered out. If it is asking, the agent gets the `asking`
status (amber pulsing dot) and the orchestrator is told the agent is waiting for input. A
later genuinely idle finish (no question on screen) still announces done as before.

The announcement is a sound, not speech (changed 2026-07-27, Rim asked for a notification
noise instead of "Name is done"). `src/lib/chime.ts` plays it with WebAudio sines, no asset
files and no Rust audio path: two rising notes for done, a three note pattern for asking, so
the two are told apart by ear. It is gated on the `announceDone` setting alone, not
`ttsEnabled`, because it is no longer speech. WebView2 blocks audio before a user gesture, so
App.tsx arms the AudioContext on the first pointerdown or keydown. The orchestrator still
speaks its own replies through Piper or SAPI; only the per agent finish announcement changed.

## Constraints that matter here

- The PC is weak: never run local LLM inference for the orchestrator, never add CPU load.
- Rust toolchain and cargo caches live on D: (`D:\rust\cargo`, `D:\rust\rustup`); C: is nearly full.
- No dashes in visible UI copy, no new code comments.
- Agent cap is 6 per launcher. Secondary orchestration: each launched agent is primed
  with the control API so it can spawn more agents itself.
