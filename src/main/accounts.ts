import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Claude Code account switching.
//
// Claude Code keeps its login in two places:
//   ~/.claude/.credentials.json  — OAuth tokens (access + refresh)
//   ~/.claude.json               — `oauthAccount` (email, accountUuid, plan info)
//
// We snapshot every distinct account we see into a profile file. A file watcher
// keeps the ACTIVE account's snapshot fresh (Claude Code rewrites the
// credentials whenever it refreshes tokens), so the stored refresh token never
// goes stale. Switching = writing the other profile's credentials back and
// patching `oauthAccount`, then restarting the claude CLIs (done by main.ts).
//
// Both accounts get captured automatically: the user just has to be logged into
// each one at least once while the launcher is running.

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

interface ConfigPaths {
  dir: string;
  credentialsFile: string;
  claudeJson: string;
}

function pathsFor(configDir?: string): ConfigPaths {
  if (!configDir) {
    return { dir: CLAUDE_DIR, credentialsFile: CREDENTIALS_FILE, claudeJson: CLAUDE_JSON };
  }
  return {
    dir: configDir,
    credentialsFile: path.join(configDir, '.credentials.json'),
    claudeJson: path.join(configDir, '.claude.json'),
  };
}

// Only these accounts take part in the Switch Account toggle. Every account
// still gets snapshotted when logged in (see startWatching), but switching
// cycles strictly within this list — so e.g. capra.rim6@gmail.com is captured
// yet never switched to. Order here is the cycle order.
const SWITCH_EMAILS = ['coldworkapp@gmail.com', 'zekrinum@gmail.com'];

function isSwitchable(email: string): boolean {
  return SWITCH_EMAILS.some((e) => e.toLowerCase() === email.trim().toLowerCase());
}

interface AccountProfile {
  accountUuid: string;
  email: string;
  savedAt: number;
  credentials: unknown;
  oauthAccount: { accountUuid?: string; emailAddress?: string } & Record<string, unknown>;
}

export interface SwitchResult {
  ok: boolean;
  email?: string;
  error?: string;
}

// A /logout (or a failed token refresh) leaves an empty token block on disk.
// Such credentials must never be snapshotted over a good profile or restored
// by a switch — either one strands the user on a dead login.
function hasTokens(credentials: unknown): boolean {
  const oauth = (credentials as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } } | null)?.claudeAiOauth;
  return !!oauth && !!(oauth.refreshToken || oauth.accessToken);
}

function profilesDir(): string {
  // Fixed shared location rather than userData: extra launcher instances run
  // with their own userData dir but must see the same saved account profiles.
  // For the primary instance this resolves to the same path as before
  // (userData defaults to %APPDATA%/agent-terminals).
  return path.join(app.getPath('appData'), 'agent-terminals', 'claude-accounts');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (_e) {
    return null;
  }
}

function currentIdentity(configDir?: string): { accountUuid: string; email: string; oauthAccount: AccountProfile['oauthAccount'] } | null {
  const cfg = readJson<{ oauthAccount?: AccountProfile['oauthAccount'] }>(pathsFor(configDir).claudeJson);
  const oa = cfg?.oauthAccount;
  if (!oa || !oa.accountUuid) return null;
  return { accountUuid: String(oa.accountUuid), email: String(oa.emailAddress || ''), oauthAccount: oa };
}

export function currentEmail(configDir?: string): string | null {
  return currentIdentity(configDir)?.email || null;
}

export function listProfiles(): AccountProfile[] {
  try {
    return fs.readdirSync(profilesDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<AccountProfile>(path.join(profilesDir(), f)))
      .filter((p): p is AccountProfile => !!p && !!p.accountUuid);
  } catch (_e) {
    return [];
  }
}

// Save the logged-in account (tokens + identity) into its profile slot.
export function snapshotCurrent(configDir?: string): void {
  const p = pathsFor(configDir);
  const id = currentIdentity(configDir);
  const credentials = readJson<unknown>(p.credentialsFile);
  // hasTokens: after /logout the credentials file is emptied while
  // .claude.json still names the account — snapshotting that state would
  // wipe the account's good profile.
  if (!id || !credentials || !hasTokens(credentials)) return;
  const profile: AccountProfile = {
    accountUuid: id.accountUuid,
    email: id.email,
    savedAt: Date.now(),
    credentials,
    oauthAccount: id.oauthAccount,
  };
  try {
    fs.mkdirSync(profilesDir(), { recursive: true });
    fs.writeFileSync(path.join(profilesDir(), `${id.accountUuid}.json`), JSON.stringify(profile, null, 2), 'utf-8');
  } catch (e) {
    console.error('[accounts] snapshot failed:', e);
  }
  propagateCredentials(p.dir, id.accountUuid, credentials);
}

// Claude Code rotates the refresh token on every refresh, and each config dir
// holds its own private copy of the credentials — so the moment one dir
// refreshes, every OTHER dir logged into the same account is left holding a
// dead token and gets logged out the next time its CLI tries to refresh.
// Whenever a dir produces fresh credentials, mirror them into all other
// watched dirs that are on the same account.
function propagateCredentials(fromDir: string, accountUuid: string, credentials: unknown): void {
  const raw = JSON.stringify(credentials);
  for (const [dir, cfgArg] of watchedDirs) {
    if (dir === fromDir) continue;
    const identity = currentIdentity(cfgArg);
    if (!identity || identity.accountUuid !== accountUuid) continue;
    const p = pathsFor(cfgArg);
    try {
      if (JSON.stringify(readJson<unknown>(p.credentialsFile)) === raw) continue;
      fs.writeFileSync(p.credentialsFile, raw, 'utf-8');
    } catch (e) {
      console.error('[accounts] propagate failed:', e);
    }
  }
}

// Only the allow-listed accounts participate, cycled in SWITCH_EMAILS order.
// Profiles whose tokens were wiped (e.g. snapshotted around a /logout by an
// older build) are excluded — restoring them would just land on a dead login.
function switchableProfiles(): AccountProfile[] {
  return listProfiles()
    .filter((prof) => isSwitchable(prof.email) && hasTokens(prof.credentials))
    .sort((a, b) => SWITCH_EMAILS.indexOf(a.email.toLowerCase()) - SWITCH_EMAILS.indexOf(b.email.toLowerCase()));
}

// Precheck for main.ts: returns the blocking error, or null when a switch can
// proceed — so the Claude CLIs are only restarted when the swap will happen.
export function canSwitch(): string | null {
  const profiles = switchableProfiles();
  if (profiles.length < 2) {
    const missing = SWITCH_EMAILS.filter((e) => !profiles.some((prof) => prof.email.toLowerCase() === e));
    return `Switching needs both accounts saved. Log into ${missing.join(' and ')} once inside a launcher Claude terminal (/logout then /login) and it will be remembered from then on.`;
  }
  return null;
}

// Swap the active Claude Code login to the next stored account.
export function switchAccount(configDir?: string): SwitchResult {
  const p = pathsFor(configDir);
  snapshotCurrent(configDir);
  const blocked = canSwitch();
  if (blocked) return { ok: false, error: blocked };
  const profiles = switchableProfiles();
  const current = currentIdentity(configDir);
  const idx = profiles.findIndex((prof) => prof.accountUuid === current?.accountUuid);
  const next = profiles[(idx + 1) % profiles.length];

  try {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.credentialsFile, JSON.stringify(next.credentials), 'utf-8');
    const cfg = readJson<Record<string, unknown>>(p.claudeJson) || {};
    cfg.oauthAccount = next.oauthAccount;
    fs.writeFileSync(p.claudeJson, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    return { ok: false, error: `Could not write Claude credentials: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, email: next.email };
}

export function seedConfigDir(configDir: string): void {
  const p = pathsFor(configDir);
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const copies: Array<[string, string]> = [
      [CREDENTIALS_FILE, p.credentialsFile],
      [CLAUDE_JSON, p.claudeJson],
      [path.join(CLAUDE_DIR, 'settings.json'), path.join(configDir, 'settings.json')],
    ];
    for (const [src, dest] of copies) {
      if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copyFileSync(src, dest);
    }
  } catch (e) {
    console.error('[accounts] seed failed:', e);
  }
}

// Keep the active account's snapshot fresh: Claude Code rewrites
// .credentials.json on login and on every token refresh.
// dir path -> the configDir argument it was registered with (undefined = the
// global ~/.claude), so propagation can re-resolve each dir's file paths.
const watchedDirs = new Map<string, string | undefined>();
const watchTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function watchConfigDir(configDir?: string): void {
  const p = pathsFor(configDir);
  if (watchedDirs.has(p.dir)) return;
  watchedDirs.set(p.dir, configDir);
  snapshotCurrent(configDir);
  try {
    fs.watch(p.dir, (_event, filename) => {
      if (filename !== '.credentials.json') return;
      const prev = watchTimers.get(p.dir);
      if (prev) clearTimeout(prev);
      watchTimers.set(p.dir, setTimeout(() => snapshotCurrent(configDir), 750));
    });
  } catch (e) {
    console.error('[accounts] watch failed:', e);
  }
}

export function startWatching(): void {
  watchConfigDir();
}
