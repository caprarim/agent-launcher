import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { backend, DirEntry } from '../lib/backend';
import { DEVICE_PRESETS, WorkspaceState } from '../lib/types';

const SHORTCUTS: Record<string, string> = {
  yt: 'https://www.youtube.com',
  youtube: 'https://www.youtube.com',
  gh: 'https://github.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  x: 'https://x.com',
  twitter: 'https://x.com',
  claude: 'https://claude.ai',
  chatgpt: 'https://chatgpt.com',
  groq: 'https://console.groq.com',
};

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const short = SHORTCUTS[value.toLowerCase()];
  if (short) return short;
  if (/^(file|about):/i.test(value)) return value;
  const bare = value.replace(/^https?:\/\//i, '');
  const short2 = SHORTCUTS[bare.toLowerCase().replace(/\/$/, '')];
  if (short2) return short2;
  const host = bare.split(/[/?#]/)[0];
  const isLocal = /^localhost(:\d+)?$/i.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host);
  const isHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host);
  if (!/\s/.test(bare) && (isLocal || isHost)) {
    if (/^https?:\/\//i.test(value)) return value;
    return `${isLocal ? 'http' : 'https'}://${bare}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(bare)}`;
}

let viewOwner = '';

function BrowserTab({ ws, hidden }: { ws: WorkspaceState; hidden: boolean }) {
  const setDock = useStore((s) => s.setDock);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const dock = ws.dock;
  const [draft, setDraft] = useState(dock.url);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const shown = useRef(false);
  const visible = !hidden && dock.open && dock.tab === 'browser' && !settingsOpen;

  useEffect(() => { setDraft(dock.url); }, [dock.url]);

  useEffect(() => {
    const node = stageRef.current;
    if (!visible || !node) {
      if (shown.current && viewOwner === ws.id) {
        shown.current = false;
        viewOwner = '';
        void backend.browserHide();
      }
      return;
    }
    const sync = () => {
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      viewOwner = ws.id;
      shown.current = true;
      void backend.browserShow(normalizeUrl(dock.url), r.left, r.top, r.width, r.height);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(node);
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [visible, dock.device, dock.width, ws.id, dock.url]);

  useEffect(() => () => {
    if (viewOwner === ws.id) {
      viewOwner = '';
      void backend.browserHide();
    }
  }, [ws.id]);

  const go = (value: string) => {
    const url = normalizeUrl(value);
    if (!url) return;
    setDock(ws.id, { url });
    setDraft(url);
    if (shown.current) void backend.browserNavigate(url);
  };

  const device = DEVICE_PRESETS.find((d) => d.id === dock.device);

  return (
    <div className="brw">
      <div className="brw-bar">
        <button className="brw-nav" title="Back" onClick={() => void backend.browserNavAction('back')}>‹</button>
        <button className="brw-nav" title="Forward" onClick={() => void backend.browserNavAction('forward')}>›</button>
        <button className="brw-nav" title="Reload" onClick={() => void backend.browserNavAction('reload')}>⟳</button>
        <input
          className="brw-url"
          value={draft}
          spellCheck={false}
          placeholder="Search or enter address"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(draft); }}
        />
        <button className="brw-open" title="Open in system browser" onClick={() => void backend.openExternal(normalizeUrl(dock.url))}>Open</button>
      </div>
      <div className="brw-devices">
        <button className={`brw-chip${!dock.device ? ' active' : ''}`} onClick={() => setDock(ws.id, { device: '' })}>Fit</button>
        {DEVICE_PRESETS.map((d) => (
          <button
            key={d.id}
            className={`brw-chip${dock.device === d.id ? ' active' : ''}`}
            title={`${d.w} x ${d.h}`}
            onClick={() => setDock(ws.id, { device: dock.device === d.id ? '' : d.id })}
          >
            {d.label}
          </button>
        ))}
        {device && <span className="brw-size">{device.w} x {device.h}</span>}
      </div>
      <div className={`brw-stage${device ? ' framed' : ''}`}>
        <div
          ref={stageRef}
          className="brw-frame"
          style={device ? { width: device.w, height: device.h } : undefined}
        />
      </div>
    </div>
  );
}

function EditorTab({ ws }: { ws: WorkspaceState }) {
  const setDock = useStore((s) => s.setDock);
  const defaultDir = useStore((s) => s.settings.defaultCwd);
  const dock = ws.dock;
  const [cwd, setCwd] = useState(dock.editorPath ? dock.editorPath.replace(/[\\/][^\\/]*$/, '') : defaultDir);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void backend.listDir(cwd).then(setEntries).catch(() => setEntries([]));
  }, []);

  const openDir = (path: string) => {
    setCwd(path);
    void backend.listDir(path).then(setEntries).catch(() => setEntries([]));
  };

  const openFile = async (path: string) => {
    const text = await backend.readTextFile(path).catch(() => '');
    setContent(text);
    setDirty(false);
    setSaved(false);
    setDock(ws.id, { editorPath: path });
  };

  const save = async () => {
    if (!dock.editorPath) return;
    await backend.writeTextFile(dock.editorPath, content).catch(() => {});
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const parent = cwd.replace(/[\\/][^\\/]*$/, '') || cwd;
  const fileName = dock.editorPath ? dock.editorPath.replace(/^.*[\\/]/, '') : '';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && dock.editorPath) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dock.editorPath, content]);

  return (
    <div className="edt">
      <div className="edt-tree">
        <div className="edt-path" title={cwd}>
          <button className="brw-nav" title="Up one folder" onClick={() => openDir(parent)}>↑</button>
          <span className="edt-cwd">{cwd || 'no folder'}</span>
        </div>
        <div className="edt-list">
          {entries.map((e) => (
            <button
              key={e.path}
              className={`edt-item${dock.editorPath === e.path ? ' active' : ''}`}
              onClick={() => (e.isDir ? openDir(e.path) : void openFile(e.path))}
            >
              <span className="edt-icon">{e.isDir ? '▸' : '·'}</span>
              <span className="edt-nm">{e.name}</span>
            </button>
          ))}
          {entries.length === 0 && <p className="edt-empty">Empty or unreadable folder.</p>}
        </div>
      </div>
      <div className="edt-main">
        <div className="edt-head">
          <span className="edt-file">{fileName || 'Pick a file to edit'}{dirty ? ' •' : ''}</span>
          <button className="brw-open" disabled={!dock.editorPath} onClick={() => void save()}>
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
        <textarea
          className="edt-area"
          value={content}
          spellCheck={false}
          placeholder={dock.editorPath ? '' : 'Open a file from the tree on the left.'}
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
        />
      </div>
    </div>
  );
}

export default function DockPanel({ ws, hidden = false }: { ws: WorkspaceState; hidden?: boolean }) {
  const setDock = useStore((s) => s.setDock);
  const dock = ws.dock;
  const startWidthResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = dock.width;
    document.body.classList.add('dragging');
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(420, Math.min(window.innerWidth - 220, startW + (startX - ev.clientX)));
      setDock(ws.id, { width: w });
    };
    const onUp = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="dock" style={{ width: dock.width, display: hidden ? 'none' : undefined }}>
      <div className="dock-resize" onPointerDown={startWidthResize} />
      <div className="dock-head">
        <button className={`dock-tab${dock.tab === 'browser' ? ' active' : ''}`} onClick={() => setDock(ws.id, { tab: 'browser' })}>Browser</button>
        <button className={`dock-tab${dock.tab === 'editor' ? ' active' : ''}`} onClick={() => setDock(ws.id, { tab: 'editor' })}>Editor</button>
        <span className="dock-spacer" />
        <button className="dock-close" onClick={() => setDock(ws.id, { open: false })}>Close</button>
      </div>
      {dock.tab === 'browser' ? <BrowserTab ws={ws} hidden={hidden} /> : <EditorTab ws={ws} />}
    </div>
  );
}
