import * as http from 'http';
import { AgentInstance, AgentType } from '../shared/types';

// Dependencies the control server needs from the main process.
export interface ControlDeps {
  // Current agent list (source of truth lives in the renderer, synced to main).
  getAgents: () => AgentInstance[];
  // Ask the renderer to add an agent; resolves with the created agent once its PTY is live.
  addAgent: (type: AgentType) => Promise<AgentInstance>;
  // Ask the renderer to remove an agent (kills the PTY too).
  removeAgent: (id: string) => Promise<boolean>;
  // Write text straight into an agent's PTY. Returns false if no such live PTY.
  writeInput: (id: string, text: string) => boolean;
  // Re-label an agent's tab from a prompt we just injected. Writing to the PTY
  // bypasses the renderer's keystroke namer entirely, so API-driven agents only
  // get a meaningful name if we ask for one here. Fire-and-forget.
  nameAgent: (id: string, prompt: string) => void;
  // Read recent output captured from an agent's PTY (optionally ANSI-stripped).
  readOutput: (id: string, opts: { raw?: boolean; tail?: number }) => string | null;
  // Whether a live PTY exists for this id.
  hasPty: (id: string) => boolean;
}

const VALID_TYPES: AgentType[] = ['claude', 'codex', 'gemini', 'cursor', 'grok'];

// Hard cap on simultaneously running agents (user requirement).
const MAX_AGENTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Strip ANSI / VT control sequences so agents reading output get clean text.
// Anchored on the ESC () or CSI () introducer, so it never touches
// ordinary letters. Equivalent to the well-known `ansi-regex` pattern, written
// with explicit unicode escapes to avoid embedding raw control chars in source.
const ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(); // guard against runaway bodies
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Starts a localhost-only HTTP control server so external processes
 * (e.g. a Claude Code agent in a terminal) can drive the launcher.
 */
export function startControlServer(
  deps: ControlDeps,
  basePort: number,
  onListening?: (port: number) => void,
): http.Server {
  // Signals that mean an agent CLI has finished booting and is waiting for input.
  // Claude prints the prompt box (box-drawing chars) and a "? for shortcuts" hint.
  const READY_MARKERS = [
    'for shortcuts', 'Welcome to Claude', 'Bypassing Permissions',
    '╭', '│ >', '> ', 'esc to interrupt',
  ];

  // Wait until an agent's terminal looks ready for input, WITHOUT a blind fixed
  // sleep. We poll its captured output and return as soon as either a known
  // "ready" marker shows up, or output has settled (CLI printed its UI then went
  // quiet). This typically takes ~2-3s instead of the old fixed 6s — and we run
  // it for every agent in parallel.
  async function waitUntilReady(
    id: string,
    opts: { minMs?: number; settleMs?: number; maxMs?: number } = {},
  ): Promise<'marker' | 'settled' | 'timeout'> {
    const minMs = opts.minMs ?? 1000;
    const settleMs = opts.settleMs ?? 650;
    const maxMs = opts.maxMs ?? 15_000;
    const start = Date.now();
    let lastLen = -1;
    let lastChange = Date.now();

    while (Date.now() - start < maxMs) {
      const raw = deps.readOutput(id, { tail: 8000 }) || '';
      const out = stripAnsi(raw);
      if (out.length !== lastLen) { lastLen = out.length; lastChange = Date.now(); }
      const elapsed = Date.now() - start;
      if (elapsed >= minMs && out.length > 0) {
        if (READY_MARKERS.some((m) => out.includes(m))) return 'marker';
        if (Date.now() - lastChange >= settleMs) return 'settled';
      }
      await sleep(110);
    }
    return 'timeout';
  }

  // Build a single-line prompt (no embedded newlines — a raw PTY treats each
  // newline as a separate Enter/submit) that gives one agent its task plus the
  // shared context of what the whole team is doing.
  function buildTeamPrompt(goal: string, tasks: string[], index: number): string {
    const n = tasks.length;
    const roster = tasks
      .map((t, i) => `Agent ${i + 1}${i === index ? ' (you)' : ''}: ${t.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
      .join(' | ');
    const mine = tasks[index].replace(/\s+/g, ' ').trim();
    return (
      `[Team build] Shared goal: ${goal.replace(/\s+/g, ' ').trim()}. ` +
      `You are Agent ${index + 1} of ${n}. Team split -> ${roster}. ` +
      `YOUR TASK (Agent ${index + 1}): ${mine}. ` +
      `Only create/modify files needed for your task so you don't collide with the other agents; ` +
      `assume they are doing their parts in parallel. Start now.`
    );
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['agents', '<id>', 'input']

    if (method === 'OPTIONS') return sendJson(res, 204, {});

    try {
      // GET /  → help / health
      if (method === 'GET' && parts.length === 0) {
        return sendJson(res, 200, {
          name: 'Agent Launcher Control API',
          endpoints: {
            'GET /agents': 'List all agent terminals',
            'POST /agents': 'Add an agent. Body: { "type": "claude" | "codex" | "gemini" | "cursor" | "grok" }',
            'POST /orchestrate': 'Spawn a team in one call (fast). Body: { "goal": "...", "tasks": ["...","..."], "type": "claude" }',
            'POST /agents/:id/input': 'Type into a terminal. Body: { "text": "...", "submit": true }',
            'GET /agents/:id/output': 'Read recent terminal output. Query: ?tail=4000&raw=1',
            'DELETE /agents/:id': 'Close a terminal',
          },
        });
      }

      // GET /agents  → list
      if (method === 'GET' && parts.length === 1 && parts[0] === 'agents') {
        return sendJson(res, 200, { agents: deps.getAgents() });
      }

      // POST /agents  → add
      if (method === 'POST' && parts.length === 1 && parts[0] === 'agents') {
        const body = await readBody(req);
        const type = String(body.type || 'claude').toLowerCase() as AgentType;
        if (!VALID_TYPES.includes(type)) {
          return sendJson(res, 400, { error: `Invalid type "${type}". Use one of: ${VALID_TYPES.join(', ')}` });
        }
        if (deps.getAgents().length >= MAX_AGENTS) {
          return sendJson(res, 409, { error: `Agent limit reached (${MAX_AGENTS} max). Close one first.` });
        }
        const agent = await deps.addAgent(type);
        return sendJson(res, 201, { agent });
      }

      // POST /orchestrate → spawn a whole team, wait for readiness in parallel,
      // and inject each agent's task + shared cross-agent context in ONE call.
      // Body: { goal: string, tasks: string[], type?: 'claude'|'codex'|'gemini' }
      if (method === 'POST' && parts.length === 1 && parts[0] === 'orchestrate') {
        const body = await readBody(req);
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        const tasks: string[] = Array.isArray(body.tasks)
          ? body.tasks.filter((t: unknown) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
          : [];
        const type = String(body.type || 'claude').toLowerCase() as AgentType;

        if (!VALID_TYPES.includes(type)) {
          return sendJson(res, 400, { error: `Invalid type "${type}". Use one of: ${VALID_TYPES.join(', ')}` });
        }
        if (!goal) return sendJson(res, 400, { error: 'Missing "goal" (the shared objective the team is building).' });
        if (tasks.length === 0) return sendJson(res, 400, { error: 'Missing "tasks": provide an array of per-agent task strings.' });

        const existing = deps.getAgents().length;
        const slots = MAX_AGENTS - existing;
        if (slots <= 0) {
          return sendJson(res, 409, { error: `Agent limit reached (${MAX_AGENTS} max, ${existing} running). Close some first.` });
        }
        const assigned = tasks.slice(0, slots); // 1 agent per task, capped at the free slots
        const dropped = tasks.slice(slots);

        // 1) Spawn every agent in parallel.
        const agents = await Promise.all(assigned.map(() => deps.addAgent(type)));

        // 2) Wait for them all to finish booting — in parallel, not 6s each.
        const readiness = await Promise.all(agents.map((a) => waitUntilReady(a.id)));

        // 3) Send each agent its task + the shared team context, in parallel.
        const results = agents.map((a, i) => {
          const prompt = buildTeamPrompt(goal, assigned, i);
          const ok = deps.writeInput(a.id, prompt + '\r');
          // Label the tab from this agent's own task, not from buildTeamPrompt's
          // output — that carries the shared goal and every sibling's task, so
          // labelling it would name all five tabs the same thing.
          if (ok) deps.nameAgent(a.id, assigned[i]);
          return {
            agent: a.id, name: a.name, index: i + 1,
            ready: readiness[i], taskSent: ok, task: assigned[i],
          };
        });

        return sendJson(res, 201, {
          goal,
          spawned: agents.length,
          agents: results,
          dropped: dropped.length ? dropped : undefined,
          note: dropped.length
            ? `${dropped.length} task(s) not assigned — would exceed the ${MAX_AGENTS}-agent limit.`
            : undefined,
        });
      }

      // /agents/:id/...
      if (parts.length >= 2 && parts[0] === 'agents') {
        const id = decodeURIComponent(parts[1]);
        const sub = parts[2];

        // DELETE /agents/:id
        if (method === 'DELETE' && !sub) {
          const ok = await deps.removeAgent(id);
          return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: `No agent "${id}"` });
        }

        // POST /agents/:id/input
        if (method === 'POST' && sub === 'input') {
          const body = await readBody(req);
          const text = typeof body.text === 'string' ? body.text : '';
          // submit defaults to true: append carriage return to send the line
          const submit = body.submit !== false;
          const payload = submit ? text + '\r' : text;
          const ok = deps.writeInput(id, payload);
          if (!ok) return sendJson(res, 404, { error: `No live terminal "${id}" (it may still be starting)` });
          // Only a submitted line is a real prompt; partial typing (submit:false)
          // is half a thought and would label the tab from a fragment.
          if (submit) deps.nameAgent(id, text);
          return sendJson(res, 200, { ok: true, sent: text.length, submitted: submit });
        }

        // GET /agents/:id/output
        if (method === 'GET' && sub === 'output') {
          const raw = url.searchParams.get('raw') === '1';
          const tailParam = url.searchParams.get('tail');
          const tail = tailParam ? parseInt(tailParam, 10) : undefined;
          const out = deps.readOutput(id, { raw, tail });
          if (out === null) return sendJson(res, 404, { error: `No agent "${id}"` });
          return sendJson(res, 200, { id, output: raw ? out : stripAnsi(out) });
        }
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { error: message });
    }
  });

  // Bind to loopback only — never expose this to the network.
  let port = basePort;
  const bind = () => server.listen(port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`[control] Agent Launcher control API on http://127.0.0.1:${port}`);
    if (onListening) onListening(port);
  });

  // A busy port usually means another launcher instance owns it (multiple
  // launchers run side by side), or a lingering prior instance is still
  // releasing the socket. Walk to the next port instead of dying silently —
  // a permanent silent failure here makes the whole control API look "down".
  let attempts = 0;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempts < 20) {
      attempts += 1;
      // eslint-disable-next-line no-console
      console.warn(`[control] port ${port} in use, trying ${port + 1}...`);
      port += 1;
      setTimeout(() => { try { server.close(); } catch (_e) {} bind(); }, 100);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[control] server error:', err);
  });

  bind();

  return server;
}

export { stripAnsi };
