import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// Stores third-party API keys (currently: Groq, for AI-assisted agent naming)
// outside the repo, in Electron's per-user userData dir — same pattern as
// accounts.ts's claude-accounts profiles. Never commit a key to source; either
// set GROQ_API_KEY in the environment or let the app persist one here.

interface AiConfig {
  groqApiKey?: string;
}

function configFile(): string {
  return path.join(app.getPath('userData'), 'ai-config.json');
}

function readConfig(): AiConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as AiConfig;
  } catch (_e) {
    return {};
  }
}

export function getGroqApiKey(): string | null {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  return readConfig().groqApiKey || null;
}

export function setGroqApiKey(key: string): void {
  const cfg = readConfig();
  cfg.groqApiKey = key;
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf-8');
}
