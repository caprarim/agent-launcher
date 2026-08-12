import { useEffect, useState } from 'react';
import { backend, Usage, UsageWindow } from '../lib/backend';

function resetLabel(win: UsageWindow | null): string {
  if (!win || !win.resetsAt) return '';
  const at = Date.parse(win.resetsAt);
  if (Number.isNaN(at)) return '';
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return 'resets now';
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH ? `resets in ${days}d ${restH}h` : `resets in ${days}d`;
}

function ageLabel(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return '';
  if (mins < 60) return `read ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `read ${hours}h ago`;
}

function Meter({ label, win, note }: { label: string; win: UsageWindow | null; note: string }) {
  if (!win) return null;
  const pct = Math.round(win.percent);
  const reset = resetLabel(win);
  const tip = [`${label} ${pct}% used`, reset, note].filter(Boolean).join(', ');
  return (
    <span className="usage-item" title={tip}>
      <span className="usage-label">{label}</span>
      <span className="usage-track">
        <span className={`usage-fill${pct >= 90 ? ' hot' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="usage-pct">{pct}%</span>
    </span>
  );
}

export default function UsageBar({ agentId, configDir }: { agentId: string; configDir?: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState<Usage | null>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    const load = async () => {
      const next = await backend.usageGet(agentId, configDir).catch(() => null);
      if (!alive) return;
      const ok = !!next && (!!next.session || !!next.week);
      if (next && ok) setUsage(next);
      setFailed(ok ? null : next);
      window.clearTimeout(timer);
      timer = window.setTimeout(load, ok ? 2000 : 3000);
    };

    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [agentId, configDir]);

  if (!usage) {
    const why = failed
      ? [failed.account, failed.error].filter(Boolean).join(': ')
      : '';
    return (
      <div className="usage-bar">
        <span className="usage-label" title={why}>{failed ? 'usage unavailable' : 'usage loading'}</span>
      </div>
    );
  }

  const note = ageLabel(usage.ageMs);

  return (
    <div className="usage-bar">
      {note && <span className="usage-note" title={usage.error || note}>{note}</span>}
      <Meter label="Session" win={usage.session} note={note} />
      <Meter label="Week" win={usage.week} note={note} />
    </div>
  );
}
