import { backend, GroqChatResponse, readScreen, dlog } from './backend';
import { useStore } from './store';
import { ChatMessage, AgentType } from './types';
import { NAME_POOL, MAX_AGENTS, pickNames, displayName } from './names';
import { deriveTitle } from './naming';

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 10;

const SIDE_EFFECT_TOOLS = new Set([
  'launch_agents', 'prompt_agent', 'close_agent', 'open_browser',
  'close_browser', 'switch_workspace', 'create_workspace',
]);

const TOOLS = [
  tool('launch_agents', 'Launch one or more Claude coding agents. Give each a task when the user described work to do.', {
    count: { type: 'integer', description: 'How many agents to launch' },
    names: { type: 'array', items: { type: 'string' }, description: 'Names for the agents, picked from the available pool' },
    tasks: { type: 'array', items: { type: 'string' }, description: 'One task per agent, copied word for word from what the user asked for, never rephrased or invented' },
  }, ['count']),
  tool('prompt_agent', 'Send a prompt straight into a named agent terminal. Only for agents that are already running.', {
    name: { type: 'string', description: 'Agent name, for example codel' },
    prompt: { type: 'string', description: 'The exact request the user made, copied word for word with every path and name intact' },
  }, ['name', 'prompt']),
  tool('read_agent', 'Read the recent terminal output of a named agent so you can summarize or check progress.', {
    name: { type: 'string' },
  }, ['name']),
  tool('agent_status', 'List every agent with its status and current task.', {}, []),
  tool('close_agent', 'Close a named agent terminal.', { name: { type: 'string' } }, ['name']),
  tool('open_browser', 'Open the built in browser at a URL.', {
    url: { type: 'string', description: 'URL to open, for example http://localhost:3000' },
  }, ['url']),
  tool('close_browser', 'Close the built in browser.', {}, []),
  tool('switch_workspace', 'Switch to another workspace by name.', { name: { type: 'string' } }, ['name']),
  tool('create_workspace', 'Create a new workspace and switch to it.', { name: { type: 'string' } }, []),
  tool('go_to_sleep', 'Go to sleep. Only when the user tells you to sleep.', {}, []),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

function systemPrompt(): string {
  const st = useStore.getState();
  const ws = st.activeWorkspace();
  const roster = st.agents
    .map((a) => {
      const where = st.workspaces.find((w) => w.id === a.workspaceId)?.name || a.workspaceId;
      const task = a.taskLabel ? `, task: ${a.taskLabel}` : '';
      return `${a.name} (${a.type}, ${a.status}, in ${where}${task})`;
    })
    .join('; ') || 'none yet';
  const free = NAME_POOL.filter((n) => !st.agents.some((a) => a.name === n)).slice(0, 8).join(', ');
  const wsNames = st.workspaces.map((w) => (w.id === ws.id ? `${w.name} (current)` : w.name)).join(', ');
  // Static instructions first, volatile state last: an identical leading block
  // lets Ollama reuse its cached prompt prefix across turns, which is a large
  // win on CPU where re evaluating the tools schema every turn dominates latency.
  return [
    'You are the voice assistant of Agent Launcher. You are a smart, capable, general purpose assistant first, and the orchestrator of a team of AI coding agents second.',
    'Answer any question, help with research, brainstorm, explain things, and hold a normal conversation. Be genuinely helpful and knowledgeable, like a strong general assistant.',
    'You also command real coding agents that run in terminals. Use a tool only when the user actually wants agents launched or driven, a preview opened, or a workspace switched. For ordinary questions and conversation, just answer directly without any tool.',
    'Never invent agents, results, or facts. If you are unsure, say so.',
    'When the user asks for agents without naming them, pick names from the unused pool.',
    'When you hand work to an agent, through the tasks field of launch_agents or the prompt field of prompt_agent, you must pass the user request itself. Copy their wording exactly, including every folder, path, file and product name they said. Do not rephrase it, do not summarize it, do not shorten it, and never add a goal they did not ask for. If their words are already a usable instruction, send them unchanged.',
    'Never invent a task. If the user did not say what the agent should do, launch it with no task and ask them what it should work on.',
    'Call each tool at most once per turn. After a tool reports success, do not call it again with the same arguments, just tell the user what happened.',
    'When asked what an agent did or how it is going, call read_agent and summarize its output.',
    'Your replies are spoken out loud, so write in plain natural sentences with no markdown, no bullet lists, and no dashes.',
    'Be brief. Answer in one or two short sentences by default, and only go longer when the user explicitly asks for detail or research. Do not greet the user back, do not ask how they are, and do not add filler or pleasantries. If the user just says hi, say a short hello and stop.',
    'When you summarize what an agent did, say it in plain everyday words in one or two sentences. Never read out file paths, code, commands, or raw terminal text. Describe the result, not the log.',
    'Never narrate hidden reasoning. Reply only with the final answer meant for the user to hear.',
    'If the user tells you to sleep, call go_to_sleep.',
    `Workspaces: ${wsNames}.`,
    `Agents right now: ${roster}.`,
    `Unused agent names you may assign: ${free}.`,
  ].join('\n');
}

// Claude Code is up and showing its input box. Any one of these is enough.
const READY_MARKERS = [
  /for shortcuts/i,
  /bypass permissions/i,
  /Welcome to Claude Code/i,
  /Claude Code v\d/i,
  /shift\+tab to cycle/i,
  /esc to interrupt/i,
];

// A bare shell prompt sitting at the end of the buffer means the CLI is NOT
// running: either it has not started yet or it died. Typing here would hand the
// task to cmd.exe, which is exactly the bug this guards against.
const SHELL_PROMPT = /(?:[A-Za-z]:\\[^\r\n]*|\$|#|>)\s*$/;
const CLI_MISSING = /is not recognized as an internal or external command/i;

const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1000;

type Readiness = 'ready' | 'not-started' | 'missing';

async function probeAgent(id: string): Promise<Readiness> {
  const screen = readScreen(id);
  if (screen !== undefined && screen.trim()) {
    let state: Readiness = 'not-started';
    if (CLI_MISSING.test(screen)) state = 'missing';
    else if (READY_MARKERS.some((re) => re.test(screen))) state = 'ready';
    dlog(`probe ${id} screen ${state} tail=${JSON.stringify(screen.trimEnd().slice(-90))}`);
    return state;
  }
  const out = (await backend.ptyOutput(id, 4000).catch(() => '')).replace(/\r/g, '');
  if (CLI_MISSING.test(out)) return 'missing';
  const tail = out.replace(/[ \t]+$/g, '').trimEnd();
  const state: Readiness =
    READY_MARKERS.some((re) => re.test(out)) && !SHELL_PROMPT.test(tail) ? 'ready' : 'not-started';
  dlog(`probe ${id} stream ${state} tail=${JSON.stringify(tail.slice(-90))}`);
  return state;
}

// Block until the agent CLI is genuinely accepting input. Never resolves "ready"
// on a timeout: callers must refuse to send rather than leak the prompt into the
// shell.
async function waitForAgentReady(id: string, timeoutMs = READY_TIMEOUT_MS): Promise<Readiness> {
  const deadline = Date.now() + timeoutMs;
  let last: Readiness = 'not-started';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
    last = await probeAgent(id);
    if (last === 'ready') return 'ready';
    if (last === 'missing') return 'missing';
  }
  return last;
}

async function sendToAgent(id: string, text: string, timeoutMs = READY_TIMEOUT_MS): Promise<Readiness> {
  const state = await waitForAgentReady(id, timeoutMs);
  if (state !== 'ready') {
    dlog(`send ${id} refused, state=${state}`);
    return state;
  }
  await new Promise((r) => setTimeout(r, 800));
  await backend.ptyWrite(id, text.replace(/\s*\n\s*/g, ' ').trim());
  await new Promise((r) => setTimeout(r, 400));
  await backend.ptyWrite(id, '\r');
  dlog(`send ${id} delivered: ${text.slice(0, 100)}`);
  return 'ready';
}

function readinessError(name: string, state: Readiness): string {
  return state === 'missing'
    ? `The claude command was not found in ${name}'s terminal, so nothing was sent. Check the claude command in settings.`
    : `${name} has not finished starting, so nothing was sent. Try again in a moment.`;
}

export function launchAgents(count: number): void {
  const st = useStore.getState();
  const room = MAX_AGENTS - st.agents.length;
  const n = Math.max(0, Math.min(count, room));
  for (let i = 0; i < n; i++) {
    primeAndTask(st.addAgent('claude').id);
  }
  if (n > 0) setTimeout(() => void backend.focusMain(), 1400);
}

// Wait for an agent CLI to boot, then hand it its task. Safe to call for every
// agent: it no ops when there is no task to send.
export function primeAndTask(id: string, task?: string): void {
  if (!task) return;
  setTimeout(async () => {
    const state = await sendToAgent(id, task);
    const st = useStore.getState();
    const agent = st.agents.find((a) => a.id === id);
    if (!agent) return;
    if (state === 'ready') {
      st.updateAgent(id, { status: 'working' });
    } else {
      st.updateAgent(id, { status: state === 'missing' ? 'exited' : 'running' });
      noteEvent(readinessError(displayName(agent.name), state));
    }
  }, 1500);
}

function chatOnce(body: Record<string, unknown>): Promise<GroqChatResponse> {
  return backend.groqChat(body);
}

// Set true while the user has asked to stop the current turn, so no further tool
// rounds fire after the in flight request is cancelled.
let cancelRequested = false;

// Stop the current orchestrator turn immediately: cancel the in flight Groq
// request and prevent any further rounds.
export function interrupt(): void {
  cancelRequested = true;
  void backend.groqCancel();
  const st = useStore.getState();
  st.updateOrch(st.activeWorkspaceId, { status: 'awake', lastReply: 'Stopped.' });
}

interface ToolResult {
  text: string;
  slept?: boolean;
}

async function execTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const st = useStore.getState();
  const wsId = st.activeWorkspaceId;
  switch (name) {
    case 'launch_agents': {
      const type: AgentType = 'claude';
      const live = useStore.getState();
      const tasks = Array.isArray(args.tasks) ? (args.tasks as string[]).filter(Boolean) : [];
      let names = Array.isArray(args.names) ? (args.names as string[]).filter(Boolean) : [];
      let count = Number(args.count) || names.length || tasks.length || 1;
      count = Math.min(count, MAX_AGENTS - live.agents.length);
      if (count <= 0) return { text: `Cannot launch more agents, the cap of ${MAX_AGENTS} is reached.` };
      const taken = live.agents.map((a) => a.name);
      if (names.length < count) names = [...names, ...pickNames(count - names.length, [...taken, ...names])];
      names = names.slice(0, count);
      names.forEach((n, i) => {
        const task = tasks[i];
        const card = live.addAgent(type, { name: n.toLowerCase(), taskLabel: task ? deriveTitle(task) : '' });
        primeAndTask(card.id, task);
      });
      setTimeout(() => void backend.focusMain(), 1400);
      const handed = tasks.length
        ? ' Their tasks are already queued and will be typed in automatically once each one boots. Do not call prompt_agent for them.'
        : '';
      return { text: `Launched ${count} ${type} agent${count > 1 ? 's' : ''}: ${names.map(displayName).join(', ')}.${handed}` };
    }
    case 'prompt_agent': {
      const agent = st.agentByName(String(args.name || ''));
      if (!agent) return { text: `No agent named ${args.name}. Current agents: ${st.agents.map((a) => a.name).join(', ') || 'none'}.` };
      const prompt = String(args.prompt || '').replace(/\s*\n\s*/g, ' ').trim();
      if (!prompt) return { text: 'Empty prompt, nothing sent.' };
      const state = await sendToAgent(agent.id, prompt, 25_000);
      if (state !== 'ready') return { text: readinessError(displayName(agent.name), state) };
      st.updateAgent(agent.id, { status: 'working', taskLabel: deriveTitle(prompt) || agent.taskLabel });
      return { text: `Sent to ${displayName(agent.name)}. Do not send it again.` };
    }
    case 'read_agent': {
      const agent = st.agentByName(String(args.name || ''));
      if (!agent) return { text: `No agent named ${args.name}.` };
      const out = await backend.ptyOutput(agent.id, 3500).catch(() => '');
      const trimmed = out.replace(/\s+/g, ' ').trim().slice(-1800);
      return { text: trimmed || 'No output yet.' };
    }
    case 'agent_status': {
      if (st.agents.length === 0) return { text: 'No agents are running.' };
      return {
        text: st.agents
          .map((a) => `${a.name}: ${a.status}${a.taskLabel ? `, working on ${a.taskLabel}` : ''}`)
          .join('; '),
      };
    }
    case 'close_agent': {
      const agent = st.agentByName(String(args.name || ''));
      if (!agent) return { text: `No agent named ${args.name}.` };
      st.removeAgent(agent.id);
      return { text: `${displayName(agent.name)} closed.` };
    }
    case 'open_browser': {
      let url = String(args.url || '').trim();
      if (!url) return { text: 'No URL given.' };
      if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
      st.setDock(wsId, { open: true, tab: 'browser', url });
      return { text: `Browser open at ${url}.` };
    }
    case 'close_browser':
      st.setDock(wsId, { open: false });
      return { text: 'Browser closed.' };
    case 'switch_workspace': {
      const ws = st.switchWorkspace(String(args.name || ''));
      return { text: ws ? `Switched to ${ws.name}.` : `No workspace named ${args.name}.` };
    }
    case 'create_workspace': {
      const ws = await st.addWorkspace(args.name ? String(args.name) : undefined);
      return { text: `Created and switched to ${ws.name}.` };
    }
    case 'go_to_sleep':
      st.updateOrch(wsId, { status: 'asleep' });
      return { text: 'Going to sleep.', slept: true };
    default:
      return { text: `Unknown tool ${name}.` };
  }
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

function forcedTool(text: string): string | undefined {
  const lower = text.toLowerCase();
  const st = useStore.getState();
  const named = st.agents.some((a) => lower.includes(a.name.toLowerCase()));
  if (named && /\b(prompt|tell|ask|send|have|instruct|order|task|get)\b/.test(lower)) return 'prompt_agent';
  if (/\b(launch|start|spin up|create|add|open)\b[^.?!]*\b(agent|agents|claude)\b/.test(lower)) return 'launch_agents';
  return undefined;
}

function salvageToolCalls(content: string): { name: string; args: string }[] {
  const out: { name: string; args: string }[] = [];
  const patterns = [
    /<function\s*=\s*([a-z_]+)\s*>\s*(\{[\s\S]*?\})\s*<\/function>/gi,
    /<function\s*=\s*([a-z_]+)\s*,?\s*(\{[\s\S]*?\})\s*>/gi,
    /"name"\s*:\s*"([a-z_]+)"\s*,\s*"(?:arguments|parameters)"\s*:\s*(\{[\s\S]*?\})\s*\}/gi,
    /\b([a-z_]+)\s*\(\s*(\{[\s\S]*?\})\s*\)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const name = m[1].toLowerCase();
      if (!TOOL_NAMES.has(name)) continue;
      try {
        JSON.parse(m[2]);
        out.push({ name, args: m[2] });
      } catch (_e) {}
    }
    if (out.length) break;
  }
  return out;
}

function stripThink(text: string): string {
  return text
    // remove complete <think>...</think> blocks
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // if only a closing tag survived, drop everything up to it (leaked reasoning)
    .replace(/^[\s\S]*?<\/think>/i, '')
    // drop a dangling opening tag and anything after it
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function noteEvent(text: string): void {
  const st = useStore.getState();
  const ws = st.activeWorkspace();
  const messages = [...ws.orchestrator.messages, { role: 'system' as const, content: `[event] ${text}` }];
  st.updateOrch(ws.id, { messages: messages.slice(-MAX_HISTORY) });
}

export async function runTurn(userText: string): Promise<void> {
  const store = useStore.getState();
  const wsId = store.activeWorkspaceId;
  const text = userText.trim();
  if (!text) return;

  if (/^(go\s+to\s+sleep|sleep)[.!]?$/i.test(text)) {
    store.updateOrch(wsId, { status: 'asleep', lastUser: text, lastReply: 'Going to sleep.' });
    if (store.settings.voiceReplies && store.settings.ttsEnabled) void backend.speak('Going to sleep');
    return;
  }

  cancelRequested = false;
  const model = store.settings.orchestratorModel;

  const ws = store.workspaces.find((w) => w.id === wsId)!;
  let messages: ChatMessage[] = [
    ...ws.orchestrator.messages,
    { role: 'user' as const, content: text },
  ].slice(-MAX_HISTORY);
  store.updateOrch(wsId, { status: 'thinking', lastUser: text, messages });

  let slept = false;
  let reply = '';
  const done = new Map<string, string>();
  try {
    const wanted = forcedTool(text);
    dlog(`turn model=${model} forced=${wanted || 'none'} text=${text.slice(0, 120)}`);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await chatOnce({
        model,
        messages: [{ role: 'system', content: systemPrompt() }, ...messages],
        tools: TOOLS,
        tool_choice: round === 0 && wanted ? { type: 'function', function: { name: wanted } } : 'auto',
        temperature: 0.4,
        max_tokens: 1024,
      });
      if (cancelRequested) return;
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new Error(res.error?.message || 'empty response');

      let calls = msg.tool_calls || [];
      if (calls.length === 0) {
        const cleaned = stripThink(msg.content || '');
        const salvaged = salvageToolCalls(cleaned);
        if (salvaged.length) {
          dlog(`round ${round} salvaged ${salvaged.map((c) => c.name).join(',')} from content`);
          calls = salvaged.map((c, i) => ({
            id: `salvaged_${round}_${i}`,
            type: 'function',
            function: { name: c.name, arguments: c.args },
          }));
        } else {
          dlog(`round ${round} content reply: ${cleaned.slice(0, 120)}`);
          reply = cleaned;
          messages = [...messages, { role: 'assistant' as const, content: reply }];
          break;
        }
      } else {
        dlog(`round ${round} tool_calls: ${calls.map((c) => `${c.function.name} ${String(c.function.arguments).slice(0, 120)}`).join(' | ')}`);
      }

      messages = [...messages, { role: 'assistant' as const, content: msg.content || '', tool_calls: calls as never }];
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        const rawArgs = call.function.arguments;
        if (typeof rawArgs === 'string') {
          try { args = JSON.parse(rawArgs); } catch (_e) {}
        } else if (rawArgs && typeof rawArgs === 'object') {
          args = rawArgs;
        }
        // Small models happily re-issue the same call every round. Replaying a
        // side effecting tool would launch duplicate agents or type the same
        // prompt into a terminal again, so each distinct call runs once a turn.
        const key = `${call.function.name}:${JSON.stringify(args)}`;
        let result: ToolResult;
        if (SIDE_EFFECT_TOOLS.has(call.function.name) && done.has(key)) {
          result = { text: `Already did that this turn: ${done.get(key)}` };
        } else {
          result = await execTool(call.function.name, args);
          done.set(key, result.text);
        }
        dlog(`tool ${call.function.name} -> ${result.text.slice(0, 140)}`);
        if (cancelRequested) return;
        if (result.slept) slept = true;
        messages = [...messages, { role: 'tool' as const, content: result.text, tool_call_id: call.id }];
      }
      if (cancelRequested) return;
      if (slept) {
        reply = 'Going to sleep.';
        break;
      }
    }
    if (!reply) reply = 'Done.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dlog(`turn error: ${msg.slice(0, 200)}`);
    // A user interrupt is a clean stop, not an error: interrupt() already set
    // the bar to "Stopped." so leave it alone.
    if (cancelRequested || msg.includes('interrupted')) return;
    reply = msg.includes('key missing')
      ? 'I need a Groq API key. Open settings and paste it in.'
      : msg.includes('rate limited') || msg.includes('429')
        ? `Groq has rate limited ${model.split('/').pop()}. Wait a minute and try again, or switch the model in settings.`
        : msg.includes('unreachable') || msg.includes('timed out')
          ? 'I cannot reach Groq. Check the internet connection.'
          : `Something went wrong: ${msg.slice(0, 140)}`;
  }

  if (cancelRequested) return;

  const finalStatus = slept ? 'asleep' : 'awake';
  const history = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  useStore.getState().updateOrch(wsId, {
    status: finalStatus,
    lastReply: reply,
    messages: history.slice(-MAX_HISTORY),
  });

  const st = useStore.getState();
  if (!slept && reply && st.settings.voiceReplies && st.settings.ttsEnabled) {
    void backend.speak(reply.slice(0, 600));
  }
}

export function wake(): void {
  const st = useStore.getState();
  const wsId = st.activeWorkspaceId;
  if (st.activeWorkspace().orchestrator.status === 'asleep') {
    st.updateOrch(wsId, { status: 'awake', lastReply: 'Listening.' });
  }
}
