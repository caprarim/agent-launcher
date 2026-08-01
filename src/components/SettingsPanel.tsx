import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { backend } from '../lib/backend';
import { bindTalkKey } from '../lib/voice';
import { GROQ_CHAT_MODELS } from '../lib/types';
import { nextZoom } from '../lib/zoom';

export default function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const accounts = useStore((s) => s.accounts);
  const loadAccounts = useStore((s) => s.loadAccounts);
  const [capturing, setCapturing] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [newAcct, setNewAcct] = useState('');
  const [mics, setMics] = useState<string[]>([]);
  const [defaultMic, setDefaultMic] = useState('');

  const loadMics = () => {
    void backend.listInputDevices().then(setMics).catch(() => setMics([]));
    void backend.defaultInputDevice().then((d) => setDefaultMic(d || '')).catch(() => setDefaultMic(''));
  };

  useEffect(() => {
    void backend.groqKeyPresent().then(setKeySaved).catch(() => setKeySaved(false));
    void loadAccounts();
    loadMics();
  }, [loadAccounts]);

  const toggleBackup = (name: string) => {
    const list = settings.micBackups || [];
    setSettings({
      micBackups: list.includes(name) ? list.filter((m) => m !== name) : [...list, name],
    });
  };

  const moveBackup = (name: string, dir: -1 | 1) => {
    const list = [...(settings.micBackups || [])];
    const i = list.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setSettings({ micBackups: list });
  };

  const addAccount = async () => {
    const n = newAcct.trim();
    if (!n) return;
    try {
      await backend.createAccount(n);
      setNewAcct('');
      await loadAccounts();
    } catch (_e) {}
  };

  const saveKey = async () => {
    const k = keyDraft.trim();
    if (!k) return;
    try {
      await backend.groqKeySet(k);
      setKeyDraft('');
      setKeySaved(true);
    } catch (_e) {
      setKeySaved(false);
    }
  };

  const captureKey = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (key === ' ') key = 'Space';
    parts.push(key);
    const combo = parts.join('+');
    setSettings({ talkKey: combo });
    void bindTalkKey(combo);
    setCapturing(false);
  };

  return (
    <div className="settings-panel">
      <div className="settings-head">
        <span className="settings-title">Settings</span>
        <button className="card-btn" title="Close settings" onClick={() => setSettingsOpen(false)}>×</button>
      </div>

      <div className="settings-section">
        <label className="settings-label">Talk key, hold it to speak to the orchestrator</label>
        <button
          className={`key-capture${capturing ? ' capturing' : ''}`}
          onClick={() => setCapturing(true)}
          onKeyDown={capturing ? captureKey : undefined}
          onBlur={() => setCapturing(false)}
        >
          {capturing ? 'Press a key combo...' : settings.talkKey}
        </button>
      </div>

      <div className="settings-section">
        <label className="settings-label">Orchestrator model, runs on Groq cloud, free tier</label>
        <div className="settings-row">
          <select
            className="settings-select"
            value={settings.orchestratorModel}
            onChange={(e) => setSettings({ orchestratorModel: e.target.value })}
          >
            {GROQ_CHAT_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <label className="settings-label">Groq API key</label>
        <div className="settings-row">
          <input
            className="settings-input"
            type="password"
            placeholder={keySaved ? 'Key saved. Paste a new one to replace it.' : 'Paste your Groq API key'}
            value={keyDraft}
            spellCheck={false}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button className="settings-btn" onClick={() => void saveKey()}>Save</button>
        </div>
        {keySaved === false && (
          <p className="settings-note warn">No Groq API key yet. Get a free one at console.groq.com and paste it here.</p>
        )}
      </div>

      <div className="settings-section">
        <label className="settings-label">Voice</label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.ttsEnabled}
            onChange={(e) => setSettings({ ttsEnabled: e.target.checked })}
          />
          Speak out loud
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.voiceReplies}
            onChange={(e) => setSettings({ voiceReplies: e.target.checked })}
          />
          Orchestrator speaks its replies
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.announceDone}
            onChange={(e) => setSettings({ announceDone: e.target.checked })}
          />
          Play a sound when an agent finishes or needs you
        </label>
        <p className="settings-note">Speech to text: {settings.voiceModel} on Groq</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Layout</label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.tileMode}
            onChange={(e) => setSettings({ tileMode: e.target.checked })}
          />
          Keep agents tiled in a grid as they are added
        </label>
        <p className="settings-note">Turn this off to place agent cards yourself</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Zoom, {Math.round(settings.uiZoom * 100)} percent</label>
        <div className="settings-row">
          <button className="settings-btn" onClick={() => setSettings({ uiZoom: nextZoom(settings.uiZoom, 'out') })}>Zoom out</button>
          <button className="settings-btn" onClick={() => setSettings({ uiZoom: nextZoom(settings.uiZoom, 'in') })}>Zoom in</button>
          <button className="settings-btn" onClick={() => setSettings({ uiZoom: 1 })}>Reset</button>
        </div>
        <p className="settings-note">Ctrl and plus to zoom in, Ctrl and minus to zoom out, Ctrl and 0 to reset</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Focus mode window size</label>
        <div className="settings-row">
          <input
            className="settings-input"
            type="number"
            min={260}
            max={2400}
            value={settings.focusW}
            onChange={(e) => setSettings({ focusW: Math.max(260, Number(e.target.value) || 560) })}
          />
          <input
            className="settings-input"
            type="number"
            min={200}
            max={2400}
            value={settings.focusH}
            onChange={(e) => setSettings({ focusH: Math.max(200, Number(e.target.value) || 760) })}
          />
        </div>
        <p className="settings-note">Size of the floating window opened by the Focus button on an agent card</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Microphone</label>
        <div className="settings-row">
          <select
            className="settings-select"
            value={settings.micDevice}
            onChange={(e) => setSettings({ micDevice: e.target.value })}
          >
            <option value="">System default{defaultMic ? ` (${defaultMic})` : ''}</option>
            {mics.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="settings-btn" title="Rescan microphones" onClick={loadMics}>Refresh</button>
        </div>
        <p className="settings-note">
          Backup microphones, tried in order if the one above sends no audio.
        </p>
        {(settings.micBackups || []).length > 0 && (
          <div className="acct-list">
            {(settings.micBackups || []).map((m, i) => (
              <div className="acct-row" key={m}>
                <span className="acct-hint">{i + 1}</span>
                <span className="acct-name">{m}</span>
                <button className="card-btn" title="Move up" onClick={() => moveBackup(m, -1)}>↑</button>
                <button className="card-btn" title="Move down" onClick={() => moveBackup(m, 1)}>↓</button>
                <button className="card-btn" title="Remove backup" onClick={() => toggleBackup(m)}>×</button>
              </div>
            ))}
          </div>
        )}
        {mics
          .filter((m) => m !== settings.micDevice && !(settings.micBackups || []).includes(m))
          .map((m) => (
            <label className="settings-check" key={m}>
              <input type="checkbox" checked={false} onChange={() => toggleBackup(m)} />
              {m}
            </label>
          ))}
        {mics.length === 0 && (
          <p className="settings-note warn">No microphones found. Plug one in and press Refresh.</p>
        )}
      </div>

      <div className="settings-section">
        <label className="settings-label">Claude accounts</label>
        <p className="settings-note">
          Each account is a separate Claude Code login. Pick one per workspace from the account button in the bar, and new agents there run under it.
        </p>
        <div className="acct-list">
          {accounts.map((a) => (
            <div className="acct-row" key={a.id}>
              <span className={`dot ${a.loggedIn ? 'ok' : 'idle'}`} />
              <span className="acct-name">{a.name}</span>
              <span className="acct-hint">{a.loggedIn ? 'logged in' : 'not logged in'}</span>
            </div>
          ))}
        </div>
        <div className="settings-row">
          <input
            className="settings-input"
            placeholder="New account name"
            value={newAcct}
            spellCheck={false}
            onChange={(e) => setNewAcct(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addAccount(); }}
          />
          <button className="settings-btn" onClick={() => void addAccount()}>Add</button>
        </div>
        <p className="settings-note">
          After adding, switch a workspace to it, launch a Claude agent, and run the login command in that terminal to sign in.
        </p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Default project folder for new agents</label>
        <input
          className="settings-input"
          value={settings.defaultCwd}
          spellCheck={false}
          onChange={(e) => setSettings({ defaultCwd: e.target.value })}
        />
      </div>

      <div className="settings-section">
        <label className="settings-label">Claude launch command</label>
        <input
          className="settings-input"
          value={settings.claudeCommand}
          spellCheck={false}
          onChange={(e) => setSettings({ claudeCommand: e.target.value })}
        />
      </div>
    </div>
  );
}
