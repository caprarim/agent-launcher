import { useEffect, useRef } from 'react';
import Canvas from './Canvas';
import OrchestratorBar from './OrchestratorBar';
import SettingsPanel from './SettingsPanel';
import AccountSwitcher from './AccountSwitcher';
import UpdateButton from './UpdateButton';
import { useStore } from '../lib/store';
import { feedTerminal, onEvent, readScreen, dlog } from '../lib/backend';
import { bindTalkKey } from '../lib/voice';
import { noteEvent, launchAgents } from '../lib/orchestrator';
import { bottom, detectAsking, isBusyScreen, isIdleScreen } from '../lib/screen';
import { armChime, playChime } from '../lib/chime';
import { applyZoom, nextZoom, zoomAction } from '../lib/zoom';

function lastMeaningfulLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : '';
}

const CONFIRM_IDLE_MS = 2600;

export default function App() {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const talkKey = useStore((s) => s.settings.talkKey);
  const tileAgents = useStore((s) => s.tileAgents);
  const tileMode = useStore((s) => s.settings.tileMode);
  const setTileMode = useStore((s) => s.setTileMode);
  const loadAccounts = useStore((s) => s.loadAccounts);
  const setDock = useStore((s) => s.setDock);
  const setSettings = useStore((s) => s.setSettings);
  const uiZoom = useStore((s) => s.settings.uiZoom);
  const focusId = useStore((s) => s.focusAgentId);
  const setFocusAgent = useStore((s) => s.setFocusAgent);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const dock = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.dock);
  const hasAgents = useStore((s) => s.agents.some((a) => a.workspaceId === s.activeWorkspaceId));
  const layoutKey = useStore((s) =>
    s.agents
      .filter((a) => a.workspaceId === s.activeWorkspaceId)
      .map((a) => `${a.id}${a.minimized ? '-min' : ''}`)
      .join(','),
  );
  const dockKey = `${dock?.open ? 1 : 0}:${dock?.width ?? 0}`;
  const confirmTimers = useRef(new Map<string, number>());

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    const timers = confirmTimers.current;

    unlisteners.push(onEvent<{ id: string; data: string }>('pty-data', ({ id, data }) => {
      feedTerminal(id, data);
    }));

    unlisteners.push(onEvent<{ id: string }>('pty-exit', ({ id }) => {
      const st = useStore.getState();
      const agent = st.agents.find((a) => a.id === id);
      if (!agent || agent.status === 'starting') return;
      window.clearTimeout(timers.get(id));
      timers.delete(id);
      st.updateAgent(id, { status: 'exited' });
    }));

    unlisteners.push(onEvent<{ id: string; tail?: string; worked?: boolean }>('agent-done', ({ id, tail, worked }) => {
      const st = useStore.getState();
      const agent = st.agents.find((a) => a.id === id);
      if (!agent || agent.status === 'exited') return;
      const line = lastMeaningfulLine(tail || '');
      st.updateAgent(id, { lastLine: line, summary: (tail || '').slice(-1400) });

      const active = agent.status === 'working' || agent.status === 'asking' ||
        (worked === true && agent.status === 'running');
      if (!active) {
        dlog(`done-event agent=${agent.name} status=${agent.status} ignored, not active`);
        return;
      }

      const screen = readScreen(id);
      if (screen === undefined || !screen.trim()) {
        dlog(`done-event agent=${agent.name} ignored, no screen to verify`);
        return;
      }
      if (isBusyScreen(screen) || !isIdleScreen(screen)) {
        dlog(`done-event agent=${agent.name} held, busy=${isBusyScreen(screen)} idle=${isIdleScreen(screen)} tail=${JSON.stringify(bottom(screen, 4).slice(-160))}`);
        return;
      }

      window.clearTimeout(confirmTimers.current.get(id));
      confirmTimers.current.set(id, window.setTimeout(() => {
        confirmTimers.current.delete(id);
        const live = useStore.getState();
        const now = live.agents.find((a) => a.id === id);
        if (!now || now.status === 'exited') return;
        const stillActive = now.status === 'working' || now.status === 'asking' ||
          (worked === true && now.status === 'running');
        if (!stillActive) return;
        const after = readScreen(id);
        if (after === undefined || !after.trim()) return;
        if (isBusyScreen(after) || !isIdleScreen(after)) {
          dlog(`done-confirm agent=${now.name} resumed, tail=${JSON.stringify(bottom(after, 4).slice(-160))}`);
          return;
        }
        const asking = detectAsking(after);
        const next = asking ? 'asking' : 'done';
        if (next === now.status) {
          dlog(`done-confirm agent=${now.name} already ${next}, no announce`);
          return;
        }
        live.updateAgent(id, { status: next });
        dlog(`announce agent=${now.name} from=${now.status} asking=${asking} tail=${JSON.stringify(bottom(after, 4).slice(-160))}`);
        if (live.settings.announceDone) {
          playChime(asking ? 'asking' : 'done');
        }
        noteEvent(asking
          ? `${now.name} is waiting for your input${now.taskLabel ? ` on ${now.taskLabel}` : ''} and needs an answer from you before it can continue`
          : `${now.name} finished working${now.taskLabel ? ` on ${now.taskLabel}` : ''}`);
      }, CONFIRM_IDLE_MS));
    }));

    unlisteners.push(onEvent<{ speaking: boolean }>('tts-state', ({ speaking }) => {
      const st = useStore.getState();
      const ws = st.activeWorkspace();
      const status = ws.orchestrator.status;
      if (speaking && status === 'awake') st.updateOrch(ws.id, { status: 'speaking' });
      else if (!speaking && status === 'speaking') st.updateOrch(ws.id, { status: 'awake' });
    }));

    const arm = () => armChime();
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);

    void loadAccounts();

    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      for (const u of unlisteners) void u.then((fn) => fn());
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, [loadAccounts]);

  useEffect(() => {
    void bindTalkKey(talkKey);
  }, [talkKey]);

  useEffect(() => {
    applyZoom(uiZoom);
  }, [uiZoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = zoomAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = useStore.getState().settings.uiZoom;
      const next = nextZoom(cur, action);
      if (next !== cur) setSettings({ uiZoom: next });
      else applyZoom(next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setSettings]);

  useEffect(() => {
    const un = onEvent('focus-exit', () => setFocusAgent(null));
    return () => { void un.then((fn) => fn()); };
  }, [setFocusAgent]);

  useEffect(() => {
    if (!tileMode || !layoutKey || focusId) return;
    tileAgents();
  }, [tileMode, layoutKey, dockKey, activeId, tileAgents, focusId]);

  useEffect(() => {
    if (!tileMode || focusId) return;
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => tileAgents(), 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, [tileMode, tileAgents, focusId]);

  const toggleDock = (tab: 'browser' | 'editor') => {
    if (dock?.open && dock.tab === tab) setDock(activeId, { open: false });
    else setDock(activeId, { open: true, tab });
  };

  return (
    <div className={`shell${focusId ? ' focus-mode' : ''}`}>
      <div className="topbar">
        <span className="brand">
          <span className="brand-dot" />
          Agent Launcher
        </span>
        <button className="top-btn primary" onClick={() => launchAgents(1)}>Add Claude Agent</button>
        {hasAgents && (
          <button
            className={`top-btn${tileMode ? ' on' : ''}`}
            title={tileMode ? 'Tile mode is on, agents stay arranged in a grid. Turn it off in settings' : 'Arrange agents in a grid and keep them arranged'}
            onClick={() => (tileMode ? tileAgents() : setTileMode(true))}
          >
            Tile
          </button>
        )}
        <span className="spacer" />
        <button
          className={`top-btn${dock?.open && dock.tab === 'browser' ? ' on' : ''}`}
          onClick={() => toggleDock('browser')}
        >
          Browser
        </button>
        <button
          className={`top-btn${dock?.open && dock.tab === 'editor' ? ' on' : ''}`}
          onClick={() => toggleDock('editor')}
        >
          Editor
        </button>
        <UpdateButton />
        <AccountSwitcher />
      </div>
      <Canvas />
      <OrchestratorBar />
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}
