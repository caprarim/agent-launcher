import { useEffect, useRef, useState } from 'react';
import { backend, dlog } from '../lib/backend';

type Phase = 'idle' | 'ready' | 'checking' | 'updating' | 'current' | 'failed';

const LABELS: Record<Phase, string> = {
  idle: 'Check for updates',
  ready: 'Update available',
  checking: 'Checking...',
  updating: 'Updating...',
  current: 'Up to date',
  failed: 'Update failed',
};

function builtLabel(ms: number): string {
  if (!ms) return 'unknown';
  return new Date(ms).toLocaleString();
}

export default function UpdateButton() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('Check for updates and install automatically');
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void backend
      .updateCheck()
      .then((info) => {
        if (cancelled || !info.available) return;
        setPhase('ready');
        setNote(`The build from ${builtLabel(info.newestBuilt)} is ready to install`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      window.clearTimeout(resetTimer.current);
    };
  }, []);

  const softReset = (ms: number) => {
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setPhase('idle'), ms);
  };

  const run = async () => {
    if (phase === 'checking' || phase === 'updating') return;
    window.clearTimeout(resetTimer.current);
    setPhase('checking');
    try {
      const info = await backend.updateCheck();
      if (!info.available) {
        setPhase('current');
        setNote(`${info.message}, built ${builtLabel(info.currentBuilt)}`);
        softReset(5000);
        return;
      }
      setPhase('updating');
      setNote(`Installing the build from ${builtLabel(info.newestBuilt)}, the app will restart`);
      dlog(`update starting source=${info.source}`);
      await backend.updateApply();
    } catch (e) {
      setPhase('failed');
      setNote(String(e));
      softReset(8000);
    }
  };

  const busy = phase === 'checking' || phase === 'updating';

  return (
    <button
      className={`top-btn update-btn${phase === 'ready' ? ' on' : ''}${phase === 'failed' ? ' bad' : ''}`}
      title={note}
      disabled={busy}
      onClick={() => void run()}
    >
      {phase === 'ready' && <span className="update-dot" />}
      {LABELS[phase]}
    </button>
  );
}
