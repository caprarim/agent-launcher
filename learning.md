# Learning Log

## Toggle viewport presets visibility
Browser toolbar has a Presets button that shows or hides the preset bar
(iPhone, Samsung, Laptop, etc.). Preference is stored in
`localStorage` key `browser.showPresets` (`1`/`0`) so it survives reloads.
Default is shown. Rebuild with `npm run build:renderer`.

## Browser viewport dimensions and presets
The right-panel browser shows live viewport size via ResizeObserver on the
webview frame. Dragging the panel resize handle sets `isDraggingPanel` and
pops a large center overlay plus a highlighted toolbar badge (`W x H`).
Seven one-click presets (5 phones, Laptop 1440x900, PC Monitor 1920x1080)
lock the webview to exact CSS pixels and widen the panel (clamped to 75% of
the main area). Manual drag clears the lock back to fluid fill. `Fluid`
button also unlocks. Rebuild with `npm run build:renderer`.

## Stop All button removed
Topbar bulk "Stop All" control and its `removeAll` handler were removed from
`App.tsx`; per-agent Close still stops one terminal. Unused `.btn-stop-all` CSS
was deleted. Rebuild renderer (`npm run build:renderer`) for dist to pick it up.

## Per-panel full screen
Each terminal header has a Full button next to Close. App tracks one
`fullscreenId`; that panel gets `position: absolute; inset: 0` over the grid
while siblings are `visibility: hidden` (kept mounted so PTYs and xterm stay
alive). ResizeObserver still fires, so fit/cols update correctly. Escape or
Exit restores the grid; closing that agent clears fullscreen.

## The Start-menu shortcut "launched nothing" — Windows foreground-lock
The shortcut spawns a second Electron; the single-instance lock makes it quit and
ask the running instance to focus its window. But `SetForegroundWindow` from a
background process is a **silent no-op** under Windows' foreground-lock (it returned
`False` and the window never surfaced) — so clicking felt dead. It was made worse by
`launch.ps1` doing a silent ~12s `npm run build` before Electron even started. Fix:
`launch.ps1` now detects an already-running launcher (by the process owning control
port 4575, else the Electron window titled "Agent Terminals") and surfaces THAT
window directly — tapping ALT to clear the foreground-lock, then
`SetForegroundWindow`, with a minimize→restore bounce as fallback — instead of
spawning a rival that just bounces off the lock. It only builds when `dist` is
missing, so a click is never blocked on a rebuild. `main.ts`'s `second-instance`
handler was also hardened (`show()` + brief always-on-top bump) for fresh builds.

## Auto-naming agents from reconstructed keystrokes
Agent panels now title themselves from what the user types (e.g. "fix the navbar
and make the UI better" -> "Fix Navbar UI"). The trick is reconstructing the
*submitted line* from raw `term.onData` keystrokes: printable chars accumulate,
Backspace/Ctrl-C/U/W edit the buffer, ESC sequences (arrow keys, bracketed-paste
markers) are stripped, and Enter (`\r`) finalizes. This works regardless of what
the TUI echoes, so it survives Claude Code's full-screen input box. A pure
`shared/naming.ts` module turns a line into keywords (stopword-filtered), keeps a
rolling 3-word window so the name updates live without growing, treats `/clear` as
a reset, and ignores confirmations ("yes") and other slash-commands. Because the
name lives on `AgentInstance` (synced to the control API), `GET /agents` now shows
friendly names too. Manual double-click rename sets a `manual` flag that pauses
auto-naming until the next `/clear`.


## Auto-naming v2: verb-object phrases beat first-N keywords
The keyword namer echoed how a prompt *opened*, not what it asked ("I have two
Claude Code accounts..." -> "Two claude code agents"). v2 (`shared/naming.ts`)
scans the WHOLE prompt for action verbs (fix/add/switch/build..., inflections
folded to base form), grabs the 1-2 concrete words each verb acts on (skipping
stopwords and vague objects like "changes"/"issue"), and composes up to two
phrases: "Fix Cold Voice and Switch Accounts". A new task line now *replaces*
the name instead of merging keywords from every past prompt, so the tab always
reflects the current task. Falls back to keywords when no verb is found.

## Input dedupe must never match escape sequences
The terminal's `onData` handler drops identical multi-char inputs arriving within
250ms (a guard against double-paste). But arrow keys aren't single chars — they're
escape sequences like `ESC[A`, which is 3 chars *and* contains a letter, so rapid
arrow presses were swallowed as "duplicates", forcing a ~1s wait between presses.
Fix: exclude any chunk containing `\x1b` (ESC) from the dedupe, since keyboard
escape sequences are legitimately identical and rapid by nature.

## Replacing fixed sleeps with readiness detection

**What it is:** Instead of blindly waiting a fixed 6 seconds for an agent's CLI to boot,
the server now watches the terminal's output and proceeds the moment the CLI is actually
ready — either because a known "ready" marker appears (e.g. Claude's prompt box) or
because the output stops changing for a short window ("settling").

**Why it was done:** A fixed sleep must be set to the *worst* case, so it wastes time on
every fast boot and still risks being too short on a slow one. Polling real output is
both faster (typically ~2–3s) and more reliable. Doing it for every agent in parallel,
inside one `/orchestrate` HTTP call, turns a ~24s serial dance (4 × spawn+6s) into a
single ~5s request.

## One newline = one Enter in a raw PTY

**What it is:** When you write text straight into a pseudo-terminal, every `\n`/`\r` is
treated as the user pressing Enter. A multi-line prompt would get submitted line-by-line.

**Why it matters:** The team-context prompt is therefore built as a *single line* (parts
joined with separators), then a single `\r` submits the whole thing at once.

## TUI mouse reporting hijacks the scroll wheel in xterm.js
Full-screen CLI agents (Claude Code etc.) enable terminal *mouse reporting*, and
xterm.js then forwards wheel events to the app instead of scrolling its own
scrollback — the pane feels "unscrollable". Fix: a capture-phase `wheel` listener on
the container that calls `term.scrollLines()` directly (Shift+wheel still passes
through; alt-buffer apps keep native handling). Also note xterm 6 replaced
`.xterm-viewport` with `.xterm-scrollable-element`, silently killing old CSS hooks.

## Custom Ctrl+V handlers must preventDefault or you paste twice
The panel's `attachCustomKeyEventHandler` pasted from the clipboard manually but
returned `false` without `e.preventDefault()`. Returning false only tells xterm to skip
its keyboard handling; the browser still fires its native `paste` event into xterm's
textarea, so the text arrived twice. The old duplicate-chunk guard masked it in plain
shells but not in Claude Code: bracketed paste wraps chunks in `\x1b[200~`, and the
guard skipped anything containing `\x1b`. One `preventDefault()` fixed it, and the
guard could be deleted.

## Auto-naming v3: an LLM upgrade pass for intent, not just keywords
v2's verb-object matcher still only sees literal wording, so a long detailed
prompt whose real point is a UI overhaul gets an accurate-but-shallow title
instead of "Improve UI". v3 keeps v2 as the instant, zero-latency title, then
fires a background call to Groq (`llama-3.1-8b-instant`) that reads the whole
prompt and infers the underlying task, swapping in its answer if it lands
before the name changes again. A per-agent generation counter (bumped on every
rename, manual or auto) lets a slow/late Groq response detect it's stale and
no-op instead of clobbering a newer name. The API key lives outside the repo
in Electron's `userData/ai-config.json` (same pattern as the Claude account
profiles) rather than in source, so it's never at risk of being committed.

## Electron's userData dir key is package.json's "name", not productName
`app.getPath('userData')` resolves under `%APPDATA%\<name>`, and defaults to
package.json's `name` field ("agent-terminals") even though the window title,
Start-menu shortcut, and installer productName all say "Agent Launcher". Two
stale userData folders existed side by side (`agent-launcher` from an old
build, `agent-terminals` from the live one) — the one actually in use is
identifiable by which one has real app data in it (e.g. `claude-accounts/`).

## Claude Code account switching is just two files
Claude Code keeps its login in `~/.claude/.credentials.json` (OAuth access + refresh
tokens) and `~/.claude.json` (`oauthAccount`: email, uuid, plan). Swapping both and
restarting the CLI switches accounts. The launcher snapshots every account it sees
(a watcher on `.credentials.json` keeps the active snapshot's refresh token fresh),
detects "limit reached" in Claude terminal output (regex avoids promo banners and
"Approaching limit" warnings, plus a 5 min cooldown), swaps files, then restarts each
claude CLI in place: Esc, Ctrl+C x2, `claude --dangerously-skip-permissions --continue`.

### Switch is now allow-listed (only 2 accounts)
`accounts.ts` gained `SWITCH_EMAILS = ['coldworkapp@gmail.com','zekrinum@gmail.com']`.
`switchAccount()` filters captured profiles to that allow-list and cycles in list order,
so a third captured account (capra.rim6@gmail.com) is snapshotted but never switched to.
With <2 of the listed accounts saved it returns a message naming exactly which one still
needs a one-time `/logout`→`/login` inside a launcher terminal to be captured. Requires
`npm run build:main` (or `npm run package`) to ship.
