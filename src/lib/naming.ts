// Auto-naming for agent terminals.
//
// Turns the prompt a user just gave an agent (e.g. "please fix the voice
// dictation and add an account switcher") into a short tab label ("Fix Voice
// Dictation") so the launcher reads like a task board instead of a wall of
// "claude-agent-8". Pure functions, no React/Electron deps, so the renderer,
// the main process and the control server all share one implementation.
//
// Two producers feed labels in:
//   1. deriveTitle()  — the local heuristic. Instant, keyword-based, offline.
//   2. an LLM         — see main/agentNamer.ts. Slower, better at picking the
//                       one thing a rambling prompt is actually about.
//
// Both are UNTRUSTED. Everything funnels through sanitizeTitle(), which is the
// single place that enforces what a label may look like. That matters because
// an LLM asked to summarise a coding task reliably reaches for the same empty
// corporate verbs ("Optimize Codebase Efficiency", "Enhance Voice Assistant"),
// and — given a long prompt — will sometimes *answer* it instead of labelling
// it ("I cannot provide a plan to gain revenue..."). A prompt alone can't stop
// that; a deterministic filter can.
//
// House style for a label: SHORT and CONCRETE. Name the thing being worked on
// — the feature, file, component or bug — in at most three plain words.

// Short words that are meaningful domain terms — never dropped, always upper-cased.
const KEEP_SHORT = new Set([
  'ui', 'ux', 'api', 'css', 'db', 'id', 'ci', 'cd', 'ai', 'io', 'os', 'cli',
  'sql', 'jwt', 'ssr', 'pr', 'qa', 'e2e',
]);

// The empty-calorie vocabulary. These say nothing about what an agent is doing:
// every coding task is, at some level, "improving quality". They are stripped
// from every label (whoever produced it) and never anchor a heuristic phrase.
//
// This set is the direct fix for tabs reading "Optimize Agent Terminal
// Performance" / "Optimize Codebase Efficiency" / "Optimize Overall System
// Architecture" — an 8B model's favourite way to say nothing at all.
const VAGUE_WORDS = new Set([
  // the "make it nicer" verb family, with inflections
  'optimize', 'optimizes', 'optimized', 'optimizing', 'optimization', 'optimizations',
  'optimise', 'optimises', 'optimised', 'optimising', 'optimisation', 'optimisations',
  'improve', 'improves', 'improved', 'improving', 'improvement', 'improvements',
  'enhance', 'enhances', 'enhanced', 'enhancing', 'enhancement', 'enhancements',
  'refine', 'refines', 'refined', 'refining', 'refinement', 'refinements',
  'streamline', 'streamlines', 'streamlined', 'streamlining',
  'revamp', 'revamps', 'revamped', 'modernize', 'modernise', 'upgrade', 'upgrades',
  'boost', 'elevate', 'perfect', 'better', 'best',
  // abstractions that could describe literally any task
  'performance', 'efficiency', 'efficient', 'quality', 'robust', 'robustness',
  'comprehensive', 'seamless', 'overall', 'various', 'general', 'holistic',
  'thorough', 'thoroughly', 'deeply', 'respectively', 'entire', 'whole',
  // bare comparatives — "Make Faster" names nothing
  'faster', 'fast', 'quicker', 'quick', 'easier', 'easy', 'simpler', 'smoother',
  'smaller', 'bigger', 'stronger', 'nicer', 'recently',
]);

// Concrete verbs that may lead a label. Anything not on this list is either a
// vague verb (banned above) or is treated as a plain word.
const ACTION_VERBS: Record<string, string> = {
  fix: 'Fix', repair: 'Fix', debug: 'Debug', solve: 'Fix', resolve: 'Fix', patch: 'Fix',
  add: 'Add', create: 'Create', build: 'Build', implement: 'Implement', write: 'Write',
  generate: 'Generate', setup: 'Setup', install: 'Install', configure: 'Configure',
  update: 'Update', change: 'Change', modify: 'Change', edit: 'Edit',
  refactor: 'Refactor', redesign: 'Redesign', rewrite: 'Rewrite', clean: 'Clean',
  simplify: 'Simplify', remove: 'Remove', delete: 'Delete', drop: 'Remove',
  disable: 'Disable', enable: 'Enable', rename: 'Rename', move: 'Move',
  convert: 'Convert', migrate: 'Migrate', merge: 'Merge', switch: 'Switch', swap: 'Swap',
  automate: 'Automate', integrate: 'Integrate', connect: 'Connect', deploy: 'Deploy',
  publish: 'Publish', release: 'Release', upload: 'Upload', download: 'Download',
  test: 'Test', verify: 'Verify', check: 'Check', review: 'Review',
  investigate: 'Investigate', analyze: 'Analyze', research: 'Research', find: 'Find',
  explore: 'Explore', trace: 'Trace', profile: 'Profile', style: 'Style',
  center: 'Center', align: 'Align', resize: 'Resize', animate: 'Animate', port: 'Port',
  translate: 'Translate', document: 'Document', explain: 'Explain', summarize: 'Summarize',
  scrape: 'Scrape', parse: 'Parse', validate: 'Validate', encrypt: 'Encrypt',
  cache: 'Cache', crop: 'Crop', compress: 'Compress', render: 'Render',
  show: 'Show', hide: 'Hide',
};
// Deliberately absent: make / handle / support. They anchor onto whatever noun
// happens to follow and produce labels like "Make Faster" or "Handle Things".

// Objects that are too vague to name a task after ("Make Changes", "Fix Issue").
const GENERIC_OBJECTS = new Set([
  'change', 'changes', 'major', 'minor', 'stuff', 'thing', 'things', 'something',
  'everything', 'anything', 'issue', 'issues', 'problem', 'problems', 'bug', 'bugs',
  'error', 'errors', 'way', 'ways', 'bit', 'lot', 'work', 'task', 'tasks', 'part',
  'parts', 'feature', 'features', 'happen', 'happens', 'happening', 'sure',
]);

// Filler that carries no "what is this agent doing" signal.
const STOPWORDS = new Set([
  // articles / conjunctions / prepositions
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from',
  'by', 'as', 'into', 'onto', 'over', 'under', 'up', 'down', 'out', 'off', 'about', 'than',
  'then', 'so', 'if', 'that', 'this', 'these', 'those', 'when', 'whenever', 'while', 'where',
  'what', 'which', 'who', 'how', 'why', 'because', 'once', 'after', 'before',
  // pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your', 'our', 'his', 'her', 'its',
  'their', 'them', 'us', 'myself', 'itself',
  // politeness / filler / vague replies
  'please', 'pls', 'thanks', 'thank', 'hey', 'hi', 'ok', 'okay', 'just', 'also', 'really',
  'very', 'much', 'more', 'most', 'some', 'any', 'all', 'now', 'here', 'there', 'currently',
  'maybe', 'yes', 'yep', 'yeah', 'no', 'nope', 'sure', 'cool', 'awesome', 'perfect', 'great',
  'nice', 'good', 'sounds', 'thx', 'done', 'well', 'anyway', 'anyways', 'actually',
  'basically', 'right', 'again', 'even', 'still', 'too', 'both', 'each', 'every', 'other',
  'literally', 'honestly', 'definitely', 'absolutely', 'simply', 'obviously', 'probably',
  // weak/generic verbs & modals
  'make', 'makes', 'let', 'lets', 'can', 'could', 'would', 'should', 'will', 'shall', 'do',
  'does', 'did', 'be', 'is', 'am', 'are', 'was', 'were', 'been', 'being', 'get', 'gets', 'got',
  'go', 'goes', 'set', 'want', 'wanna', 'need', 'needs', 'help', 'use', 'uses', 'using', 'try',
  'look', 'looks', 'looking', 'see', 'made', 'have', 'has', 'had', 'keep', 'put', 'say', 'says',
  'said', 'tell', 'told', 'ask', 'asked', 'give', 'take', 'come', 'know',
  // vague adjectives/adverbs
  'cleaner', 'new', 'old', 'pretty', 'like', 'little',
]);

// A label is a glance, not a sentence. Three words is the ceiling.
const MAX_TITLE_WORDS = 3;
const MAX_TITLE_LEN = 24;

// Tells that an LLM answered the prompt (or refused it) instead of labelling it.
// Seen in the wild from llama-3.1-8b on long, chatty prompts:
//   "I cannot provide a plan to gain revenue. Is there anything..."
//   "I'd need more context about your project to provide specific..."
// Conversational follow-ups. These are replies to the agent, not new tasks, so
// they must not re-label a tab that already says what the agent is doing.
// ("yes go ahead" used to rename a tab to "Ahead".)
const CONTINUATION_RE =
  /^(yes|yep|yeah|ok|okay|sure|no|nope|go|do|try|run|continue|proceed|carry|keep|stop|wait|fine|great|thanks|thank|perfect|cool|nice|please|now|next|and|also|then)\b/i;
const MAX_CONTINUATION_WORDS = 4;

const PROSE_TELLS = [
  'i cannot', 'i can not', "i can't", 'i am unable', "i'm unable", "i'd need", 'i would need',
  'i need more', 'sorry', 'as an ai', 'as a language model', 'here is', "here's",
  'is there anything', 'let me know', 'unfortunately', 'it seems', 'it looks like',
  'please provide', 'could you', 'based on',
];

function titleWord(w: string): string {
  const lower = w.toLowerCase();
  if (KEEP_SHORT.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Fold common verb inflections back to their base form for ACTION_VERBS lookup:
// fixes -> fix, fixing -> fix, switched -> switch.
function verbDisplay(word: string): string | null {
  if (VAGUE_WORDS.has(word)) return null; // never anchor on "optimize"/"improve"
  if (ACTION_VERBS[word]) return ACTION_VERBS[word];
  const tries: string[] = [];
  if (word.endsWith('ing')) { tries.push(word.slice(0, -3), word.slice(0, -3) + 'e'); }
  if (word.endsWith('ed'))  { tries.push(word.slice(0, -2), word.slice(0, -1)); }
  if (word.endsWith('es'))  { tries.push(word.slice(0, -2)); }
  if (word.endsWith('s'))   { tries.push(word.slice(0, -1)); }
  for (const t of tries) if (ACTION_VERBS[t]) return ACTION_VERBS[t];
  return null;
}

// Words that may never appear in a label, from any producer.
function isNoise(word: string): boolean {
  return VAGUE_WORDS.has(word) || STOPWORDS.has(word) || GENERIC_OBJECTS.has(word);
}

// Singularize trivially so "accounts" and "account" dedupe to the same object.
function objectKey(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function tokenize(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[`'"()[\]{}.,!?;:@#]/g, ' ')
    .split(/[\s/\\_-]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

/**
 * The one gate every label passes through, whoever produced it — the local
 * heuristic or an LLM. Strips vague words, rejects prose, and clamps to the
 * house style (<= 3 words, <= 24 chars, Title Case).
 *
 * Returns null when nothing usable survives, so the caller can fall back.
 *
 *   "Optimize Agent Terminal Performance"  -> "Agent Terminal"
 *   "Optimize Codebase Efficiency"         -> "Codebase"
 *   "Enhance Voice Assistant"              -> "Voice Assistant"
 *   "Mac Os Updates"                       -> "Mac OS Updates"
 *   "I cannot provide a plan to gain..."   -> null   (prose, not a label)
 */
export function sanitizeTitle(raw: string): string | null {
  if (!raw) return null;

  // First line only, stripped of wrapping quotes/backticks/periods.
  let s = raw.split('\n')[0].trim();
  s = s.replace(/^["'`*.\s]+|["'`*.\s]+$/g, '');
  if (!s) return null;

  const lower = s.toLowerCase();

  // An answer or a refusal, not a label. Truncating one to 24 chars produces a
  // worse tab name than having none, so bail and let the caller fall back.
  if (PROSE_TELLS.some((tell) => lower.includes(tell))) return null;
  if (s.includes('?')) return null;
  if (s.split(/\s+/).length > 8) return null; // a sentence escaped the model

  const words: string[] = [];
  for (const token of tokenize(s)) {
    if (isNoise(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (token.length < 2 && !KEEP_SHORT.has(token)) continue;
    if (words.some((w) => w.toLowerCase() === token)) continue; // "Terminal Terminal"
    words.push(token);
    if (words.length >= MAX_TITLE_WORDS) break;
  }
  if (words.length === 0) return null;

  let title = words.map(titleWord).join(' ');
  if (title.length > MAX_TITLE_LEN) {
    title = title.slice(0, MAX_TITLE_LEN).replace(/\s+\S*$/, ''); // never cut mid-word
  }
  return title || null;
}

/**
 * Keep sibling tabs distinguishable. Two agents pointed at the same area of the
 * codebase legitimately produce the same label; without this they render as two
 * identical tabs and the launcher stops being readable.
 *
 *   "Terminal Speed" (taken) -> "Terminal Speed 2"
 */
export function dedupeTitle(title: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(title.toLowerCase())) return title;
  for (let n = 2; n < 100; n++) {
    const candidate = `${title} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return title;
}

interface Phrase { verb: string; objects: string[] }

/**
 * Scan the whole prompt for "action verb + object" pairs, e.g.
 * "please fix the cold voice dictation" -> { verb: 'Fix', objects: ['cold','voice'] }.
 * A verb only forms a phrase when a concrete (non-filler, non-vague) object
 * appears within the next few words.
 */
function derivePhrases(prompt: string, maxPhrases = 1): Phrase[] {
  const tokens = tokenize(prompt);
  const phrases: Phrase[] = [];
  const seenObjects = new Set<string>();

  for (let i = 0; i < tokens.length && phrases.length < maxPhrases; i++) {
    const verb = verbDisplay(tokens[i]);
    if (!verb) continue;

    const objects: string[] = [];
    for (let j = i + 1; j < tokens.length && j <= i + 8 && objects.length < 2; j++) {
      const t = tokens[j];
      if (verbDisplay(t)) break; // ran into the next task's verb
      if (isNoise(t)) continue;
      if (/^\d+$/.test(t)) continue;
      if (t.length < 2 && !KEEP_SHORT.has(t)) continue;
      if (objects.length === 0 && seenObjects.has(objectKey(t))) break; // duplicate task mention
      objects.push(t);
    }
    if (objects.length === 0) continue;

    objects.forEach((o) => seenObjects.add(objectKey(o)));
    phrases.push({ verb, objects: objects.map(titleWord) });
    i += objects.length; // don't re-anchor inside the object we just consumed
  }
  return phrases;
}

/**
 * Extract up to `max` meaningful keywords from a prompt, title-cased.
 * Fallback for prompts with no recognizable action verb — and the main path for
 * "optimize the terminal renaming", where the verb is deliberately unusable and
 * the label becomes the noun phrase ("Terminal Renaming").
 */
export function deriveKeywords(prompt: string, max = MAX_TITLE_WORDS): string[] {
  const kept: string[] = [];
  for (const clean of tokenize(prompt)) {
    if (isNoise(clean)) continue;
    if (/^\d+$/.test(clean)) continue;
    if (clean.length < 2 && !KEEP_SHORT.has(clean)) continue;
    if (kept.includes(clean)) continue;
    kept.push(clean);
    if (kept.length >= max) break;
  }
  return kept.map(titleWord);
}

/**
 * Build a short task label from a prompt, offline. Prefers a "Verb Object"
 * phrase ("Fix Voice Dictation"); falls back to bare keywords when the prompt
 * has no usable action verb. Returns '' for pure filler.
 */
export function deriveTitle(prompt: string): string {
  const phrases = derivePhrases(prompt);
  if (phrases.length > 0) {
    const p = phrases[0];
    const cleaned = sanitizeTitle(`${p.verb} ${p.objects.join(' ')}`);
    if (cleaned) return cleaned;
  }
  return sanitizeTitle(deriveKeywords(prompt).join(' ')) || '';
}

/**
 * Given a submitted terminal line, classify it for naming purposes.
 *  - 'clear'  : a "/clear" (or "/reset") command — reset the name to default.
 *  - 'command': any other slash-command — ignore for naming.
 *  - 'task'   : a real instruction; `title` is the new name for the terminal.
 *  - 'ignore' : too short / pure filler (confirmations like "yes", "go on").
 *
 * A new task REPLACES the previous name (the terminal shows what the agent is
 * working on now), it no longer merges keywords from every past prompt.
 */
export function classifyLine(
  line: string,
): { kind: 'clear' | 'command' | 'ignore' | 'task'; title: string } {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignore', title: '' };

  if (trimmed.startsWith('/')) {
    const cmd = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
    if (cmd === 'clear' || cmd === 'reset') return { kind: 'clear', title: '' };
    return { kind: 'command', title: '' };
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) return { kind: 'ignore', title: '' };

  // "yes go ahead", "ok try again", "continue" — a reply, not a new task.
  if (wordCount <= MAX_CONTINUATION_WORDS && CONTINUATION_RE.test(trimmed)) {
    return { kind: 'ignore', title: '' };
  }

  const title = deriveTitle(trimmed);
  if (!title) return { kind: 'ignore', title: '' };

  return { kind: 'task', title };
}
