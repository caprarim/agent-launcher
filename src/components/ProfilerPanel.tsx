import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backend, CostReport, Usage } from '../lib/backend';

type View = 'overview' | 'models' | 'sessions' | 'projects' | 'skills' | 'memory' | 'config';

interface FileRef {
  name: string;
  path: string;
  sub: string;
  readOnly?: boolean;
}

interface Paths {
  home: string;
  config: string;
}

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: When to use this skill. Write the trigger, not just the topic.
---

# ${name}

Describe what this skill does and the steps to follow.
`;

function money(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function shortDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export default function ProfilerPanel({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>('overview');
  const [paths, setPaths] = useState<Paths | null>(null);
  const [report, setReport] = useState<CostReport | null>(null);
  const [costError, setCostError] = useState('');
  const [scanning, setScanning] = useState(true);
  const [usage, setUsage] = useState<Usage | null>(null);

  const [skills, setSkills] = useState<FileRef[]>([]);
  const [memory, setMemory] = useState<FileRef[]>([]);
  const [configFiles, setConfigFiles] = useState<FileRef[]>([]);

  const [selected, setSelected] = useState<FileRef | null>(null);
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [fileError, setFileError] = useState('');
  const [savedAt, setSavedAt] = useState(0);
  const [newSkill, setNewSkill] = useState('');
  const mounted = useRef(true);

  const loadCosts = useCallback(async () => {
    setScanning(true);
    setCostError('');
    try {
      const r = await backend.usageCosts();
      if (mounted.current) setReport(r);
    } catch (e) {
      if (mounted.current) setCostError(String(e));
    }
    if (mounted.current) setScanning(false);
  }, []);

  const loadSkills = useCallback(async (home: string) => {
    try {
      const entries = await backend.listDir(`${home}/.claude/skills`);
      setSkills(
        entries
          .filter((e) => e.isDir)
          .map((e) => ({ name: e.name, path: `${e.path}/SKILL.md`, sub: 'SKILL.md' })),
      );
    } catch (_e) {
      setSkills([]);
    }
  }, []);

  const loadMemory = useCallback(async (configDir: string) => {
    const found: FileRef[] = [];
    try {
      const accounts = await backend.listDir(`${configDir}/claude-accounts`);
      for (const account of accounts.filter((a) => a.isDir)) {
        let projects: { name: string; path: string; isDir: boolean }[] = [];
        try {
          projects = await backend.listDir(`${account.path}/projects`);
        } catch (_e) {
          continue;
        }
        for (const project of projects.filter((p) => p.isDir)) {
          try {
            const files = await backend.listDir(`${project.path}/memory`);
            for (const f of files.filter((f) => !f.isDir && f.name.endsWith('.md'))) {
              found.push({ name: f.name, path: f.path, sub: `${account.name} · ${project.name}` });
            }
          } catch (_e) {}
        }
      }
    } catch (_e) {}
    found.sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name)));
    setMemory(found);
  }, []);

  const loadConfigFiles = useCallback(async (home: string) => {
    const found: FileRef[] = [
      { name: 'CLAUDE.md', path: `${home}/.claude/CLAUDE.md`, sub: 'global instructions' },
      { name: 'settings.json', path: `${home}/.claude/settings.json`, sub: 'claude settings' },
      { name: '.claude.json', path: `${home}/.claude.json`, sub: 'read only', readOnly: true },
    ];
    try {
      const rules = await backend.listDir(`${home}/.claude/rules`);
      for (const r of rules.filter((r) => !r.isDir && r.name.endsWith('.md'))) {
        found.push({ name: r.name, path: r.path, sub: 'rules' });
      }
    } catch (_e) {}
    setConfigFiles(found);
  }, []);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const [home, config] = await Promise.all([backend.homeDir(), backend.configDir()]);
        if (!mounted.current) return;
        setPaths({ home, config });
        void loadSkills(home);
        void loadMemory(config);
        void loadConfigFiles(home);
      } catch (e) {
        setCostError(String(e));
      }
      void loadCosts();
      try {
        const u = await backend.usageGet();
        if (mounted.current) setUsage(u);
      } catch (_e) {}
    })();
    return () => {
      mounted.current = false;
    };
  }, [loadCosts, loadSkills, loadMemory, loadConfigFiles]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el.tagName.toLowerCase() === 'textarea') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const openFile = useCallback(async (ref: FileRef) => {
    setSelected(ref);
    setFileError('');
    setSavedAt(0);
    try {
      const content = await backend.readTextFile(ref.path);
      setText(content);
      setOriginal(content);
    } catch (_e) {
      setText('');
      setOriginal('');
      setFileError('This file does not exist yet. Saving will create it.');
    }
  }, []);

  const save = useCallback(async () => {
    if (!selected || selected.readOnly) return;
    try {
      await backend.writeTextFile(selected.path, text);
      setOriginal(text);
      setSavedAt(Date.now());
      setFileError('');
    } catch (e) {
      setFileError(String(e));
    }
  }, [selected, text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const addSkill = useCallback(async () => {
    if (!paths) return;
    const slug = slugify(newSkill);
    if (!slug) return;
    const dir = `${paths.home}/.claude/skills/${slug}`;
    try {
      await backend.createDir(dir);
      await backend.writeTextFile(`${dir}/SKILL.md`, SKILL_TEMPLATE(slug));
      setNewSkill('');
      await loadSkills(paths.home);
      void openFile({ name: slug, path: `${dir}/SKILL.md`, sub: 'SKILL.md' });
    } catch (e) {
      setFileError(String(e));
    }
  }, [paths, newSkill, loadSkills, openFile]);

  const dirty = selected != null && text !== original;

  const nav: { group: string; items: { id: View; label: string; count?: number }[] }[] = useMemo(
    () => [
      {
        group: 'Usage and cost',
        items: [
          { id: 'overview', label: 'Overview' },
          { id: 'models', label: 'By model', count: report?.models.length },
          { id: 'sessions', label: 'By session', count: report?.sessionCount },
          { id: 'projects', label: 'By project', count: report?.projects.length },
        ],
      },
      {
        group: 'Claude setup',
        items: [
          { id: 'skills', label: 'Skills', count: skills.length },
          { id: 'memory', label: 'Memory', count: memory.length },
          { id: 'config', label: 'Config files', count: configFiles.length },
        ],
      },
    ],
    [report, skills.length, memory.length, configFiles.length],
  );

  const editorFiles = view === 'skills' ? skills : view === 'memory' ? memory : configFiles;

  const renderEditor = (emptyLabel: string) => (
    <div className="profiler-split">
      <div className="profiler-list">
        {editorFiles.length === 0 && <div className="profiler-empty">{emptyLabel}</div>}
        {editorFiles.map((f) => (
          <button
            key={f.path}
            className={`profiler-list-item${selected?.path === f.path ? ' on' : ''}`}
            onClick={() => void openFile(f)}
          >
            {f.name}
            <span className="profiler-list-sub">{f.sub}</span>
          </button>
        ))}
      </div>
      <div className="profiler-editor">
        {!selected && <div className="profiler-empty">Pick a file on the left to read and edit it.</div>}
        {selected && (
          <>
            <div className="profiler-editor-head">
              <span className="profiler-editor-path">{selected.path}</span>
              {savedAt > 0 && !dirty && <span className="profiler-saved">Saved</span>}
              {dirty && <span className="profiler-hint">Unsaved</span>}
              <button className="profiler-btn" onClick={() => setText(original)} disabled={!dirty}>
                Revert
              </button>
              <button
                className="profiler-btn primary"
                onClick={() => void save()}
                disabled={!dirty || !!selected.readOnly}
              >
                Save
              </button>
            </div>
            {fileError && <div className="profiler-error">{fileError}</div>}
            <textarea
              className="profiler-textarea"
              value={text}
              readOnly={!!selected.readOnly}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="profiler-note">
              {selected.readOnly ? 'Read only, Claude Code owns this file.' : 'Ctrl+S saves. Writes straight to the file on disk.'}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const maxDay = report ? Math.max(0.0001, ...report.days.map((d) => d.cost)) : 1;
  const topModelCost = report && report.models.length ? report.models[0].cost : 1;

  return (
    <div className="profiler">
      <div className="profiler-top">
        <span className="profiler-brand">Profiler</span>
        <span className="profiler-sub">
          {scanning
            ? 'Reading session transcripts'
            : report
              ? `${report.sessionCount} sessions · ${report.fileCount} transcripts · ${report.scannedMs}ms`
              : 'No data'}
        </span>
        <span className="spacer" />
        <button className="profiler-btn" onClick={() => void loadCosts()} disabled={scanning}>
          {scanning ? 'Scanning' : 'Rescan'}
        </button>
        <button className="profiler-btn" onClick={onClose}>Close</button>
      </div>

      <div className="profiler-body">
        <nav className="profiler-nav">
          {nav.map((g) => (
            <div key={g.group}>
              <div className="profiler-nav-group">{g.group}</div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  className={`profiler-nav-item${view === it.id ? ' on' : ''}`}
                  onClick={() => {
                    setView(it.id);
                    setSelected(null);
                    setFileError('');
                  }}
                >
                  {it.label}
                  {it.count != null && <span className="profiler-nav-count">{it.count}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="profiler-main">
          {view === 'overview' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">API equivalent spend</span>
                <span className="profiler-hint">what these sessions would have cost at list API prices</span>
              </div>
              {costError && <div className="profiler-error">{costError}</div>}
              <div className="profiler-cards">
                {([
                  ['Last 24 hours', report?.day],
                  ['Last 7 days', report?.week],
                  ['Last 30 days', report?.month],
                  ['All time', report?.total],
                ] as const).map(([label, b]) => (
                  <div className="profiler-card" key={label}>
                    <div className="profiler-card-label">{label}</div>
                    <div className={`profiler-card-value${label === 'All time' ? ' accent' : ''}`}>
                      {b ? money(b.cost) : '—'}
                    </div>
                    <div className="profiler-card-foot">
                      {b
                        ? `${compact(b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheWrite)} tokens · ${b.messages} replies`
                        : 'scanning'}
                    </div>
                  </div>
                ))}
              </div>

              {usage && (usage.session || usage.week) && (
                <div className="profiler-card wide">
                  <div className="profiler-card-title">Subscription limits</div>
                  {usage.session && (
                    <div className="profiler-meter">
                      <div className="profiler-meter-head">
                        <span>Current session</span>
                        <span>{Math.round(usage.session.percent)}% used</span>
                      </div>
                      <div className="profiler-meter-track">
                        <div
                          className="profiler-meter-fill"
                          style={{ width: `${Math.min(100, usage.session.percent)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {usage.week && (
                    <div className="profiler-meter">
                      <div className="profiler-meter-head">
                        <span>Current week, all models</span>
                        <span>{Math.round(usage.week.percent)}% used</span>
                      </div>
                      <div className="profiler-meter-track">
                        <div
                          className="profiler-meter-fill mute"
                          style={{ width: `${Math.min(100, usage.week.percent)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  <div className="profiler-note">
                    Limits come from your plan. The dollar figures above are what the same tokens would cost on the API.
                  </div>
                </div>
              )}

              {report && report.days.length > 0 && (
                <div className="profiler-card wide">
                  <div className="profiler-card-title">Daily spend, last 30 days</div>
                  <div className="profiler-chart">
                    {report.days.map((d) => (
                      <div
                        key={d.date}
                        className="profiler-bar"
                        style={{ height: `${Math.max(2, (d.cost / maxDay) * 100)}%` }}
                        title={`${d.date}  ${money(d.cost)}`}
                      />
                    ))}
                  </div>
                  <div className="profiler-chart-axis">
                    <span>{report.days[0]?.date}</span>
                    <span>peak {money(maxDay)}</span>
                    <span>{report.days[report.days.length - 1]?.date}</span>
                  </div>
                </div>
              )}

              <div className="profiler-note">
                Counted from Claude Code transcripts on this machine, deduplicated by message id. Cache reads bill at
                10 percent of input, cache writes at 2x for the 1 hour cache and 1.25x for the 5 minute cache. Work done
                on other machines or on claude.ai is not included.
              </div>
            </>
          )}

          {view === 'models' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">Cost by model</span>
                <span className="profiler-hint">all time</span>
              </div>
              <div className="profiler-card">
                <table className="profiler-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Rate in / out per 1M</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cache read</th>
                      <th>Cache write</th>
                      <th>Replies</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.models ?? []).map((m) => (
                      <tr key={m.model}>
                        <td className="name">{m.model}</td>
                        <td>${m.rateInput} / ${m.rateOutput}</td>
                        <td className="num">{compact(m.tokens.input)}</td>
                        <td className="num">{compact(m.tokens.output)}</td>
                        <td className="num">{compact(m.tokens.cacheRead)}</td>
                        <td className="num">{compact(m.tokens.cacheWrite)}</td>
                        <td className="num">{m.messages}</td>
                        <td className="cost">{money(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!report?.models.length && <div className="profiler-empty">No model usage found.</div>}
              </div>
              {!!report?.models.length && (
                <div className="profiler-card wide">
                  <div className="profiler-card-title">Share of spend</div>
                  {report.models.map((m) => (
                    <div className="profiler-meter" key={m.model}>
                      <div className="profiler-meter-head">
                        <span>{m.model}</span>
                        <span>{money(m.cost)}</span>
                      </div>
                      <div className="profiler-meter-track">
                        <div className="profiler-meter-fill" style={{ width: `${(m.cost / topModelCost) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {view === 'sessions' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">Most expensive sessions</span>
                <span className="profiler-hint">top 25 of {report?.sessionCount ?? 0}</span>
              </div>
              <div className="profiler-card">
                <table className="profiler-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Models</th>
                      <th>Started</th>
                      <th>Tokens</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.sessions ?? []).map((s) => (
                      <tr key={s.id}>
                        <td className="name">{s.project}</td>
                        <td>{s.models.join(', ')}</td>
                        <td>{shortDate(s.startedAt)}</td>
                        <td className="num">
                          {compact(s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite)}
                        </td>
                        <td className="cost">{money(s.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!report?.sessions.length && <div className="profiler-empty">No sessions found.</div>}
              </div>
            </>
          )}

          {view === 'projects' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">Cost by project</span>
                <span className="profiler-hint">all time</span>
              </div>
              <div className="profiler-card">
                <table className="profiler-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Sessions</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.projects ?? []).map((p) => (
                      <tr key={p.project}>
                        <td className="name">{p.project}</td>
                        <td className="num">{p.sessions}</td>
                        <td className="cost">{money(p.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!report?.projects.length && <div className="profiler-empty">No projects found.</div>}
              </div>
            </>
          )}

          {view === 'skills' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">Skills</span>
                <span className="profiler-hint">{paths ? `${paths.home}/.claude/skills` : ''}</span>
              </div>
              <div className="profiler-new">
                <input
                  className="profiler-input"
                  placeholder="New skill name"
                  value={newSkill}
                  onChange={(e) => setNewSkill(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addSkill();
                  }}
                />
                <button className="profiler-btn primary" onClick={() => void addSkill()} disabled={!slugify(newSkill)}>
                  Add skill
                </button>
              </div>
              {renderEditor('No skills yet.')}
            </>
          )}

          {view === 'memory' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">Memory</span>
                <span className="profiler-hint">what Claude remembers between sessions</span>
              </div>
              {renderEditor('No memory files yet.')}
            </>
          )}

          {view === 'config' && (
            <>
              <div className="profiler-main-head">
                <span className="profiler-h">Config files</span>
                <span className="profiler-hint">global instructions, rules and settings</span>
              </div>
              {renderEditor('No config files found.')}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
