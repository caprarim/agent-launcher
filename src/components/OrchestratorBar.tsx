import { useState } from 'react';
import { useStore } from '../lib/store';
import { backend } from '../lib/backend';
import { runTurn, interrupt } from '../lib/orchestrator';
import { startTalk, stopTalk } from '../lib/voice';

export default function OrchestratorBar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const setActive = useStore((s) => s.setActiveWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState('');

  const ws = workspaces.find((w) => w.id === activeId) || workspaces[0];
  const orch = ws.orchestrator;
  const asleep = orch.status === 'asleep';
  const busy = orch.status === 'thinking' || orch.status === 'speaking';

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void backend.speakStop();
    void runTurn(text);
  };

  const stop = () => {
    void backend.speakStop();
    interrupt();
  };

  if (asleep) {
    return (
      <div className="orch-bar asleep">
        <span className="orb asleep" />
        <span className="orch-hint">Asleep. Hold {settings.talkKey} to wake and talk.</span>
      </div>
    );
  }

  return (
    <div className="orch-bar">
      <div className="ws-pills">
        {workspaces.map((w) => (
          <button
            key={w.id}
            className={`ws-pill${w.id === activeId ? ' active' : ''}`}
            onClick={() => setActive(w.id)}
            title={w.name}
          >
            {w.name}
            {workspaces.length > 1 && w.id === activeId && (
              <span
                className="ws-pill-x"
                title="Close workspace"
                onClick={(e) => { e.stopPropagation(); removeWorkspace(w.id); }}
              >×</span>
            )}
          </button>
        ))}
        <button className="ws-pill add" title="New workspace" onClick={() => void addWorkspace()}>+</button>
      </div>

      <span className={`orb ${orch.status}`} />

      {busy && (
        <button className="stop-btn" title="Stop the orchestrator" onClick={stop}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          Stop
        </button>
      )}

      <div className="orch-center">
        {orch.status === 'listening' ? (
          <span className="orch-live">{orch.liveText ? `“${orch.liveText}”` : 'Listening...'}</span>
        ) : orch.status === 'thinking' ? (
          <span className="orch-live">{orch.lastUser ? `“${orch.lastUser}”` : 'Thinking...'}</span>
        ) : orch.status === 'speaking' ? (
          <span className="orch-reply" title={orch.lastReply}>{orch.lastReply || 'Speaking...'}</span>
        ) : orch.lastReply ? (
          <span className="orch-reply" title={orch.lastReply}>{orch.lastReply}</span>
        ) : (
          <span className="orch-hint">Hold {settings.talkKey} and speak, or type below.</span>
        )}
        <input
          className="orch-input"
          placeholder={`Tell the orchestrator of ${ws.name}...`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
      </div>

      <button
        className={`mic-btn${orch.status === 'listening' ? ' live' : ''}`}
        title={`Hold to talk (${settings.talkKey})`}
        onPointerDown={() => void startTalk()}
        onPointerUp={() => void stopTalk()}
        onPointerLeave={() => { if (orch.status === 'listening') void stopTalk(); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm6-4a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-3.06A8 8 0 0 0 20 11h-2Z" />
        </svg>
      </button>

      <button className="chip" title="Orchestrator model, click for settings" onClick={() => setSettingsOpen(true)}>
        {(settings.orchestratorModel.split('/').pop() || settings.orchestratorModel).replace('llama-', '')}
      </button>
      <button className="chip gear" title="Settings" onClick={() => setSettingsOpen(true)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.4 4a7.8 7.8 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L16.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.8 7.8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />
        </svg>
      </button>
    </div>
  );
}
