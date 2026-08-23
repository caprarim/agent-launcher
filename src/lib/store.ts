import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  AGENT_LABELS, AGENT_TYPES, AgentCard, AgentType, ClaudeAccount, DEFAULT_PRESETS, DEFAULT_SETTINGS, DockState,
  GROQ_CHAT_MODELS, GROQ_VOICE_MODEL, LaunchPreset, LogEntry, OrchestratorState, Settings, WorkspaceState,
} from './types';
import { displayName, pickNames } from './names';
import { backend } from './backend';

const MAX_LOG = 60;

function freshOrchestrator(): OrchestratorState {
  return { status: 'awake', messages: [], lastUser: '', lastReply: '', liveText: '', log: [] };
}

function freshWorkspace(id: string, name: string, configDir?: string): WorkspaceState {
  return {
    id,
    name,
    configDir,
    accountId: 'default',
    orchestrator: freshOrchestrator(),
    dock: { open: false, tab: 'browser', width: 760, url: 'https://google.com', device: '', editorPath: '' },
  };
}

interface StoreState {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  agents: AgentCard[];
  accounts: ClaudeAccount[];
  settings: Settings;
  settingsOpen: boolean;
  profilerOpen: boolean;
  paletteOpen: boolean;
  zCounter: number;
  focusAgentId: string | null;

  activeWorkspace: () => WorkspaceState;
  addWorkspace: (name?: string) => Promise<WorkspaceState>;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  switchWorkspace: (query: string) => WorkspaceState | null;
  setActiveWorkspace: (id: string) => void;

  loadAccounts: () => Promise<void>;
  setWorkspaceAccount: (wsId: string, accountId: string) => void;

  addAgent: (type: AgentType, opts?: { name?: string; taskLabel?: string; cwd?: string; workspaceId?: string }) => AgentCard;
  removeAgent: (id: string) => void;
  updateAgent: (id: string, patch: Partial<AgentCard>) => void;
  agentByName: (name: string) => AgentCard | undefined;
  relaunchAgent: (id: string) => Promise<void>;
  bringToFront: (id: string) => number;
  toggleExpand: (id: string) => void;
  toggleMinimize: (id: string) => void;
  tileAgents: () => void;
  setTileMode: (on: boolean) => void;
  setFocusAgent: (id: string | null) => void;

  setDock: (wsId: string, patch: Partial<DockState>) => void;
  updateOrch: (wsId: string, patch: Partial<OrchestratorState>) => void;
  pushLog: (wsId: string, role: LogEntry['role'], text: string) => void;
  clearLog: (wsId: string) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setProfilerOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;

  addPreset: (label: string, count: number, type: AgentType) => void;
  removePreset: (id: string) => void;
}

let agentCounter = 0;
let logCounter = 0;

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      workspaces: [freshWorkspace('default', 'Workspace 1')],
      activeWorkspaceId: 'default',
      agents: [],
      accounts: [],
      settings: DEFAULT_SETTINGS,
      settingsOpen: false,
      profilerOpen: false,
      paletteOpen: false,
      zCounter: 10,
      focusAgentId: null,

      activeWorkspace: () => {
        const st = get();
        return st.workspaces.find((w) => w.id === st.activeWorkspaceId) || st.workspaces[0];
      },

      addWorkspace: async (name) => {
        const id = `ws-${Date.now()}`;
        const wsName = (name || `Workspace ${get().workspaces.length + 1}`).slice(0, 40);
        let configDir: string | undefined;
        try {
          configDir = await backend.ensureWorkspaceConfig(id);
        } catch (_e) {}
        const ws = freshWorkspace(id, wsName, configDir);
        set((st) => ({ workspaces: [...st.workspaces, ws], activeWorkspaceId: id }));
        return ws;
      },

      removeWorkspace: (id) => {
        const st = get();
        if (st.workspaces.length <= 1) return;
        for (const a of st.agents.filter((a) => a.workspaceId === id)) {
          void backend.ptyKill(a.id);
          if (st.focusAgentId === a.id) get().setFocusAgent(null);
        }
        const next = st.workspaces.filter((w) => w.id !== id);
        set({
          workspaces: next,
          agents: st.agents.filter((a) => a.workspaceId !== id),
          activeWorkspaceId: st.activeWorkspaceId === id ? next[0].id : st.activeWorkspaceId,
        });
      },

      renameWorkspace: (id, name) => {
        set((st) => ({
          workspaces: st.workspaces.map((w) => (w.id === id ? { ...w, name: name.slice(0, 40) } : w)),
        }));
      },

      switchWorkspace: (query) => {
        const q = query.trim().toLowerCase();
        const ws = get().workspaces.find(
          (w) => w.name.toLowerCase() === q || w.name.toLowerCase().includes(q) || w.id === q,
        );
        if (ws) set({ activeWorkspaceId: ws.id });
        return ws || null;
      },

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

      loadAccounts: async () => {
        try {
          const list = await backend.listAccounts();
          set({ accounts: list });
        } catch (_e) {}
      },

      setWorkspaceAccount: (wsId, accountId) => {
        const st = get();
        const account = st.accounts.find((a) => a.id === accountId);
        set({
          workspaces: st.workspaces.map((w) =>
            w.id === wsId ? { ...w, accountId, configDir: account && account.dir ? account.dir : undefined } : w,
          ),
        });
        for (const a of get().agents.filter((a) => a.workspaceId === wsId && a.type === 'claude')) {
          void get().relaunchAgent(a.id);
        }
      },

      addAgent: (type, opts = {}) => {
        const st = get();
        const wsId = opts.workspaceId || st.activeWorkspaceId;
        const taken = st.agents.map((a) => a.name);
        const name = (opts.name || pickNames(1, taken)[0]).toLowerCase();
        const count = st.agents.filter((a) => a.workspaceId === wsId).length;
        agentCounter += 1;
        const z = st.zCounter + 1;
        const card: AgentCard = {
          id: `${type}-${Date.now()}-${agentCounter}`,
          type,
          name,
          taskLabel: opts.taskLabel || '',
          status: 'starting',
          workspaceId: wsId,
          cwd: opts.cwd || st.settings.defaultCwd,
          x: 40 + (count % 4) * 44,
          y: 74 + (count % 4) * 40,
          w: 620,
          h: 400,
          z,
          expanded: false,
          minimized: false,
          epoch: 0,
          lastLine: '',
          summary: '',
          accountId: st.workspaces.find((w) => w.id === wsId)?.accountId || 'default',
        };
        set((s) => ({ agents: [...s.agents, card], zCounter: z }));
        return card;
      },

      removeAgent: (id) => {
        void backend.ptyKill(id);
        if (get().focusAgentId === id) get().setFocusAgent(null);
        set((st) => ({ agents: st.agents.filter((a) => a.id !== id) }));
      },

      updateAgent: (id, patch) => {
        set((st) => ({ agents: st.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
      },

      agentByName: (name) => {
        const q = name.trim().toLowerCase();
        const st = get();
        const direct =
          st.agents.find((a) => a.name.toLowerCase() === q && a.workspaceId === st.activeWorkspaceId) ||
          st.agents.find((a) => a.name.toLowerCase() === q) ||
          st.agents.find((a) => a.name.toLowerCase().startsWith(q) && q.length >= 3);
        if (direct) return direct;
        const first = q.split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
        if (!first) return undefined;
        return (
          st.agents.find((a) => a.name.toLowerCase() === first) ||
          st.agents.find((a) => first.length >= 3 && a.name.toLowerCase().startsWith(first)) ||
          st.agents.find((a) => a.name.toLowerCase() && q.includes(a.name.toLowerCase()))
        );
      },

      relaunchAgent: async (id) => {
        await backend.ptyKill(id).catch(() => {});
        set((st) => ({
          agents: st.agents.map((a) =>
            a.id === id
              ? {
                  ...a,
                  epoch: a.epoch + 1,
                  status: 'starting',
                  lastLine: '',
                  summary: '',
                  accountId: st.workspaces.find((w) => w.id === a.workspaceId)?.accountId || 'default',
                }
              : a,
          ),
        }));
      },

      bringToFront: (id) => {
        const z = get().zCounter + 1;
        set((st) => ({
          zCounter: z,
          agents: st.agents.map((a) => (a.id === id ? { ...a, z } : a)),
        }));
        return z;
      },

      toggleExpand: (id) => {
        const z = get().zCounter + 1;
        set((st) => ({
          zCounter: z,
          agents: st.agents.map((a) =>
            a.id === id ? { ...a, expanded: !a.expanded, minimized: false, z } : a,
          ),
        }));
      },

      toggleMinimize: (id) => {
        set((st) => ({
          agents: st.agents.map((a) =>
            a.id === id ? { ...a, minimized: !a.minimized, expanded: false } : a,
          ),
        }));
      },

      tileAgents: () => {
        const st = get();
        const wsId = st.activeWorkspaceId;
        const mine = st.agents.filter((a) => a.workspaceId === wsId && !a.minimized);
        if (mine.length === 0) return;
        const pad = 12;
        const top = 64;
        const bottom = 104;
        const ws = st.workspaces.find((w) => w.id === wsId);
        const dockW = ws && ws.dock.open ? ws.dock.width + pad : 0;
        const areaW = window.innerWidth - pad * 2 - dockW;
        const areaH = window.innerHeight - top - bottom;
        const cols = Math.ceil(Math.sqrt(mine.length));
        const rows = Math.ceil(mine.length / cols);
        const cw = Math.floor((areaW - pad * (cols - 1)) / cols);
        const ch = Math.floor((areaH - pad * (rows - 1)) / rows);
        const laid = new Map<string, { x: number; y: number; w: number; h: number }>();
        mine.forEach((a, i) => {
          const c = i % cols;
          const r = Math.floor(i / cols);
          laid.set(a.id, {
            x: pad + c * (cw + pad),
            y: top + r * (ch + pad),
            w: Math.max(320, cw),
            h: Math.max(200, ch),
          });
        });
        set({
          agents: st.agents.map((a) => {
            const box = laid.get(a.id);
            return box ? { ...a, ...box, expanded: false } : a;
          }),
        });
      },

      setTileMode: (on) => {
        set((st) => ({ settings: { ...st.settings, tileMode: on } }));
        if (on) get().tileAgents();
      },

      setFocusAgent: (id) => {
        const st = get();
        if (st.focusAgentId === id) return;
        const agent = id ? st.agents.find((a) => a.id === id) : undefined;
        if (id && !agent) return;
        if (agent) {
          const ws = st.workspaces.find((w) => w.id === agent.workspaceId);
          if (ws && ws.dock.open) void backend.browserHide();
          set((s) => ({
            focusAgentId: id,
            activeWorkspaceId: agent.workspaceId,
            agents: s.agents.map((a) =>
              a.id === id ? { ...a, minimized: false, expanded: false } : a,
            ),
          }));
          void backend
            .focusMode(true, st.settings.focusW, st.settings.focusH, displayName(agent.name))
            .catch(() => {});
        } else {
          set({ focusAgentId: null });
          void backend.focusMode(false, 0, 0).catch(() => {});
        }
      },

      setDock: (wsId, patch) => {
        set((st) => ({
          workspaces: st.workspaces.map((w) =>
            w.id === wsId ? { ...w, dock: { ...w.dock, ...patch } } : w,
          ),
        }));
      },

      updateOrch: (wsId, patch) => {
        set((st) => ({
          workspaces: st.workspaces.map((w) =>
            w.id === wsId ? { ...w, orchestrator: { ...w.orchestrator, ...patch } } : w,
          ),
        }));
      },

      pushLog: (wsId, role, text) => {
        const clean = text.trim();
        if (!clean) return;
        logCounter += 1;
        const entry: LogEntry = { id: `l${Date.now()}-${logCounter}`, role, text: clean, at: Date.now() };
        set((st) => ({
          workspaces: st.workspaces.map((w) =>
            w.id === wsId
              ? { ...w, orchestrator: { ...w.orchestrator, log: [...w.orchestrator.log, entry].slice(-MAX_LOG) } }
              : w,
          ),
        }));
      },

      clearLog: (wsId) => {
        set((st) => ({
          workspaces: st.workspaces.map((w) =>
            w.id === wsId ? { ...w, orchestrator: { ...w.orchestrator, log: [], messages: [] } } : w,
          ),
        }));
      },

      setSettings: (patch) => set((st) => ({ settings: { ...st.settings, ...patch } })),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setProfilerOpen: (open) => set({ profilerOpen: open }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),

      addPreset: (label, count, type) => {
        const kind: AgentType = AGENT_TYPES.includes(type) ? type : 'claude';
        const n = Math.max(1, Math.min(6, Math.round(count)));
        const clean = label.trim().slice(0, 24) || `${n} ${AGENT_LABELS[kind]}`;
        const preset: LaunchPreset = { id: `p${Date.now()}`, label: clean, count: n, type: kind };
        set((st) => ({ settings: { ...st.settings, presets: [...st.settings.presets, preset] } }));
      },

      removePreset: (id) => {
        set((st) => ({ settings: { ...st.settings, presets: st.settings.presets.filter((p) => p.id !== id) } }));
      },
    }),
    {
      name: 'agent-launcher-v3',
      partialize: (st) => ({ settings: st.settings }),
      merge: (persisted, current) => {
        const saved = (persisted as { settings?: Partial<Settings> })?.settings || {};
        const settings = { ...current.settings, ...saved };
        if (!GROQ_CHAT_MODELS.includes(settings.orchestratorModel)) {
          settings.orchestratorModel = DEFAULT_SETTINGS.orchestratorModel;
        }
        if (settings.voiceModel !== GROQ_VOICE_MODEL) {
          settings.voiceModel = GROQ_VOICE_MODEL;
        }
        if (!settings.claudeCommand) settings.claudeCommand = DEFAULT_SETTINGS.claudeCommand;
        if (!settings.codexCommand) settings.codexCommand = DEFAULT_SETTINGS.codexCommand;
        if (typeof settings.micDevice !== 'string') settings.micDevice = '';
        if (typeof settings.tileMode !== 'boolean') settings.tileMode = DEFAULT_SETTINGS.tileMode;
        if (typeof settings.uiZoom !== 'number' || !(settings.uiZoom > 0)) {
          settings.uiZoom = DEFAULT_SETTINGS.uiZoom;
        }
        settings.uiZoom = Math.max(0.4, Math.min(3, settings.uiZoom));
        if (typeof settings.focusW !== 'number' || settings.focusW < 260) {
          settings.focusW = DEFAULT_SETTINGS.focusW;
        }
        if (typeof settings.focusH !== 'number' || settings.focusH < 200) {
          settings.focusH = DEFAULT_SETTINGS.focusH;
        }
        if (!Array.isArray(settings.micBackups)) settings.micBackups = [];
        if (!Array.isArray(settings.presets) || settings.presets.length === 0) {
          settings.presets = DEFAULT_PRESETS;
        } else {
          settings.presets = settings.presets.map((p) =>
            AGENT_TYPES.includes(p.type) ? p : { ...p, type: 'claude' as AgentType },
          );
          for (const preset of DEFAULT_PRESETS) {
            if (preset.type === 'codex' && !settings.presets.some((p) => p.id === preset.id)) {
              settings.presets = [...settings.presets, preset];
            }
          }
        }
        return { ...current, settings };
      },
    },
  ),
);

