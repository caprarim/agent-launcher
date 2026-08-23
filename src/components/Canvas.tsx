import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { launchAgents } from '../lib/orchestrator';
import { AGENT_LABELS, AgentType, WorkspaceState } from '../lib/types';
import TerminalCard from './TerminalCard';
import DockPanel from './DockPanel';

function Starfield() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const grad = ctx.createRadialGradient(w * 0.5, h * 1.2, h * 0.2, w * 0.5, h * 0.2, h * 1.3);
      grad.addColorStop(0, '#0d1119');
      grad.addColorStop(1, '#0a0d14');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      const rand = mulberry32(7);
      for (let i = 0; i < 160; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = rand() * 1.1 + 0.2;
        const a = rand() * 0.35 + 0.08;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(214, 222, 240, ${a.toFixed(3)})`;
        ctx.fill();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return <canvas ref={ref} className="starfield" aria-hidden />;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function EmptyState({ ws }: { ws: WorkspaceState }) {
  const presets = useStore((s) => s.settings.presets);
  const addPreset = useStore((s) => s.addPreset);
  const removePreset = useStore((s) => s.removePreset);
  const [adding, setAdding] = useState(false);
  const [count, setCount] = useState(2);
  const [kind, setKind] = useState<AgentType>('claude');

  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="var(--accent)"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg>
      </div>
      <p className="empty-title">{ws.name}</p>
      <p className="empty-hint">Hold the talk key and say launch three claude agents, or add one below. Each opens as a live terminal.</p>

      <div className="empty-actions">
        <button className="launch-btn" onClick={() => launchAgents(1, 'claude')}>Add Claude Agent</button>
        <button className="launch-btn" onClick={() => launchAgents(1, 'codex')}>Add Codex Agent</button>
      </div>

      <div className="presets">
        <div className="presets-head">
          <span className="presets-title">Quick launch presets</span>
          <button className="preset-new" onClick={() => setAdding((v) => !v)}>+ New preset</button>
        </div>
        <div className="presets-row">
          {presets.map((p) => (
            <span className="preset-wrap" key={p.id}>
              <button className="preset" onClick={() => launchAgents(p.count, p.type)}>{p.label}</button>
              <button className="preset-x" title="Remove preset" onClick={() => removePreset(p.id)}>×</button>
            </span>
          ))}
        </div>
        {adding && (
          <div className="preset-add">
            <span className="preset-add-label">Launch</span>
            <input
              className="preset-count"
              type="number"
              min={1}
              max={6}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(6, Number(e.target.value) || 1)))}
            />
            <select
              className="preset-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as AgentType)}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <span className="preset-add-label">agents</span>
            <button
              className="preset-save"
              onClick={() => { addPreset(`${count} ${AGENT_LABELS[kind]}`, count, kind); setAdding(false); }}
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Canvas() {
  const agents = useStore((s) => s.agents);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const focusId = useStore((s) => s.focusAgentId);
  const ws = workspaces.find((w) => w.id === activeId) || workspaces[0];
  const visibleCount = agents.filter((a) => a.workspaceId === ws.id).length;

  return (
    <div className={`canvas${ws.dock.open && !focusId ? ' with-dock' : ''}`}>
      <Starfield />
      {visibleCount === 0 && !ws.dock.open && !focusId && <EmptyState ws={ws} />}
      {agents.map((a) => (
        <TerminalCard
          key={`${a.id}-${a.epoch}`}
          agent={a}
          hidden={a.workspaceId !== ws.id || (!!focusId && a.id !== focusId)}
        />
      ))}
      {ws.dock.open && !focusId && <DockPanel ws={ws} />}
    </div>
  );
}
