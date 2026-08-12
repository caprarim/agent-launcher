import { useEffect, useRef } from 'react';
import Canvas from './Canvas';
import OrchestratorBar from './OrchestratorBar';
import SettingsPanel from './SettingsPanel';
import AccountSwitcher from './AccountSwitcher';
import UpdateButton from './UpdateButton';
import { useStore } from '../lib/store';
import { backend, feedTerminal, onEvent, readScreen, dlog } from '../lib/backend';
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
const RETRY_IDLE_MS = 1500;
const MAX_SETTLE_TRIES = 60;
const DONE_MESSAGE = 'Clawd has finished working.';

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

    const settle = (id: string, worked: boolean | undefined, tries: number, steady: number) => {
      confirmTimers.current.delete(id);
      const live = useStore.getState();
      const now = live.agents.find((a) => a.id === id);
      if (!now || now.status === 'exited') return;
      const stillActive = now.status === 'working' || now.status === 'asking' ||
        (worked === true && now.status === 'running');
      if (!stillActive) return;

      const screen = readScreen(id) ?? '';
      const quiet = !!screen.trim() && !isBusyScreen(screen) && isIdleScreen(screen);
      if (!quiet) {
        if (tries >= MAX_SETTLE_TRIES) {
          dlog(`done-settle agent=${now.name} gave up, tail=${JSON.stringify(bottom(screen, 4).slice(-160))}`);
          return;
        }
        confirmTimers.current.set(id, window.setTimeout(() => settle(id, worked, tries + 1, 0), RETRY_IDLE_MS));
        return;
      }
      if (steady === 0) {
        confirmTimers.current.set(id, window.setTimeout(() => settle(id, worked, tries + 1, 1), CONFIRM_IDLE_MS));
        return;
      }

      const asking = detectAsking(screen);
      const next = asking ? 'asking' : 'done';
      if (next === now.status) {
        dlog(`done-confirm agent=${now.name} already ${next}, no announce`);
        return;
      }
      live.updateAgent(id, { status: next });
      dlog(`announce agent=${now.name} from=${now.status} asking=${asking} tail=${JSON.stringify(bottom(screen, 4).slice(-160))}`);
      if (live.settings.announceDone) {
        playChime(asking ? 'asking' : 'done');
      }
      void backend.notifyAgentDone(DONE_MESSAGE);
      noteEvent(asking
        ? `${now.name} is waiting for your input${now.taskLabel ? ` on ${now.taskLabel}` : ''} and needs an answer from you before it can continue`
        : `${now.name} finished working${now.taskLabel ? ` on ${now.taskLabel}` : ''}`);
    };

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

      window.clearTimeout(confirmTimers.current.get(id));
      settle(id, worked, 0, 0);
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
    let sawDown = false;
    let lastEscAt = 0;
    const escTarget = (): string | null => {
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName.toLowerCase();
        const editable = tag === 'input' || tag === 'select' || el.isContentEditable
          || (tag === 'textarea' && !el.classList.contains('xterm-helper-textarea'));
        if (editable) return null;
        const card = el.closest('[data-agent-id]');
        const owned = card?.getAttribute('data-agent-id');
        if (owned) return owned;
      }
      const st = useStore.getState();
      if (st.settingsOpen || st.paletteOpen) return null;
      if (st.focusAgentId) return st.focusAgentId;
      const pool = st.agents.filter(
        (a) => a.workspaceId === st.activeWorkspaceId && a.status !== 'exited' && !a.minimized,
      );
      if (!pool.length) return null;
      return pool.reduce((top, a) => (a.z > top.z ? a : top), pool[0]).id;
    };
    const send = (phase: string): boolean => {
      const now = Date.now();
      if (now - lastEscAt < 100) return true;
      const el = document.activeElement as HTMLElement | null;
      const where = el ? `${el.tagName.toLowerCase()}.${el.className || 'none'}`.slice(0, 60) : 'null';
      const id = escTarget();
      if (!id) {
        dlog(`esc ${phase} no target, focus=${where}`);
        return false;
      }
      lastEscAt = now;
      void backend.ptyWrite(id, '\x1b')
        .then((queued) => dlog(`esc ${phase} to ${id} queued=${queued} focus=${where}`))
        .catch((err) => dlog(`esc ${phase} to ${id} failed ${String(err).slice(0, 80)}`));
      return true;
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.altKey || e.ctrlKey || e.metaKey) return;
      sawDown = true;
      if (send('keydown')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.altKey || e.ctrlKey || e.metaKey) return;
      if (sawDown) {
        sawDown = false;
        return;
      }
      if (send('keyup')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    const un = onEvent('hw-escape', () => { send('native'); });
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      void un.then((fn) => fn());
    };
  }, []);

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
