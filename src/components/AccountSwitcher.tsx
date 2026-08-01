import { useState } from 'react';
import { useStore } from '../lib/store';

export default function AccountSwitcher() {
  const accounts = useStore((s) => s.accounts);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const setWorkspaceAccount = useStore((s) => s.setWorkspaceAccount);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);

  const currentId = ws?.accountId || 'default';
  const current = accounts.find((a) => a.id === currentId);
  const label = current ? current.name : 'Main';

  return (
    <div className="acct">
      <button className="top-btn acct-btn" title="Claude account for this workspace" onClick={() => setOpen((v) => !v)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6Z" />
        </svg>
        {label}
        <span className="acct-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="acct-backdrop" onClick={() => setOpen(false)} />
          <div className="acct-menu top">
            <div className="acct-menu-title">Account for {ws?.name || 'this workspace'}</div>
            {accounts.map((a) => (
              <button
                key={a.id}
                className={`acct-item${a.id === currentId ? ' active' : ''}`}
                onClick={() => { setWorkspaceAccount(activeId, a.id); setOpen(false); }}
              >
                <span className={`dot ${a.loggedIn ? 'ok' : 'idle'}`} />
                <span className="acct-name">{a.name}</span>
                {!a.loggedIn && <span className="acct-hint">sign in needed</span>}
              </button>
            ))}
            <button className="acct-item manage" onClick={() => { setSettingsOpen(true); setOpen(false); }}>
              Manage accounts
            </button>
          </div>
        </>
      )}
    </div>
  );
}
