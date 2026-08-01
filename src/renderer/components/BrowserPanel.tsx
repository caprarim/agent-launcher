import React, { useRef, useState, useEffect, KeyboardEvent, useCallback } from 'react';

interface Props {
  onClose: () => void;
  isDragging: boolean;
  onApplyWidth: (width: number) => void;
}

interface ViewportPreset {
  id: string;
  label: string;
  w: number;
  h: number;
}

const PRESETS: ViewportPreset[] = [
  { id: 'iphone17pm', label: 'iPhone 17 Pro Max', w: 440, h: 956 },
  { id: 's26ultra',   label: 'Samsung S26 Ultra', w: 412, h: 915 },
  { id: 'iphone16',   label: 'iPhone 16',         w: 393, h: 852 },
  { id: 'pixel9',     label: 'Pixel 9',           w: 412, h: 915 },
  { id: 'iphonese',   label: 'iPhone SE',         w: 375, h: 667 },
  { id: 'laptop',     label: 'Laptop',            w: 1440, h: 900 },
  { id: 'monitor',    label: 'PC Monitor',        w: 1920, h: 1080 },
];

// Electron ships a <webview> tag with its own navigation history. WebKitGTK,
// which is what Tauri renders with on Linux, does not — so that build gets an
// iframe plus a history stack kept here. Everything else about the pane (the
// viewport presets, the live size badge, the resize handle) is identical.
const HAS_WEBVIEW = window.electronAPI.hasWebview;

function displayUrl(u: string): string {
  if (!u || u === 'about:blank') return '';
  return u;
}

/** Resolve address-bar text into a loadable URL (or Google search). */
function resolveNavigateUrl(raw: string): string | null {
  const target = raw.trim();
  if (!target) return null;

  if (/^(https?|file|about):/i.test(target)) return target;

  if (/\s/.test(target)) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(target);
  }

  if (
    /^localhost(?::\d+)?(?:[/?#]|$)/i.test(target) ||
    /^127\.\d+\.\d+\.\d+(?::\d+)?(?:[/?#]|$)/.test(target) ||
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/.test(target) ||
    /^\[::1\](?::\d+)?(?:[/?#]|$)/i.test(target)
  ) {
    return 'http://' + target;
  }

  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d+(?:[/?#].*)?$/.test(target)) {
    return 'http://' + target;
  }

  if (target.includes('.') && !target.startsWith('.')) {
    return 'https://' + target;
  }

  return 'https://www.google.com/search?q=' + encodeURIComponent(target);
}

export default function BrowserPanel({
  isDragging,
  onApplyWidth,
}: Props): JSX.Element {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('about:blank');
  const [inputUrl, setInputUrl] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [lockedSize, setLockedSize] = useState<{ w: number; h: number } | null>(null);
  // Iframe-only navigation state: a same-origin guarantee is not available, so
  // the pane owns its own history instead of reading the frame's.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [showPresets, setShowPresets] = useState(() => {
    try {
      return localStorage.getItem('browser.showPresets') !== '0';
    } catch {
      return true;
    }
  });

  const togglePresets = useCallback(() => {
    setShowPresets((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('browser.showPresets', next ? '1' : '0');
      } catch {
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!HAS_WEBVIEW) return;
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = () => {
      const u = wv.getURL();
      setUrl(u);
      setInputUrl(displayUrl(u));
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };

    const onStart = () => setLoading(true);
    const onStop  = () => { setLoading(false); onNavigate(); };

    wv.addEventListener('did-start-loading',    onStart);
    wv.addEventListener('did-stop-loading',     onStop);
    wv.addEventListener('did-navigate',         onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);

    return () => {
      wv.removeEventListener('did-start-loading',    onStart);
      wv.removeEventListener('did-stop-loading',     onStop);
      wv.removeEventListener('did-navigate',         onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [lockedSize]);

  const goToHistory = useCallback((index: number) => {
    setHistoryIndex(index);
    setUrl(history[index]);
    setInputUrl(displayUrl(history[index]));
    setCanGoBack(index > 0);
    setCanGoForward(index < history.length - 1);
    setLoading(true);
  }, [history]);

  const navigate = (raw: string) => {
    const target = resolveNavigateUrl(raw);
    if (!target) return;
    setInputUrl(displayUrl(target));

    if (HAS_WEBVIEW) {
      webviewRef.current?.loadURL(target);
      return;
    }

    const next = [...history.slice(0, historyIndex + 1), target];
    setHistory(next);
    setHistoryIndex(next.length - 1);
    setUrl(target);
    setCanGoBack(next.length > 1);
    setCanGoForward(false);
    setLoading(true);
  };

  const goBack = () => {
    if (HAS_WEBVIEW) return webviewRef.current?.goBack();
    if (historyIndex > 0) goToHistory(historyIndex - 1);
  };

  const goForward = () => {
    if (HAS_WEBVIEW) return webviewRef.current?.goForward();
    if (historyIndex < history.length - 1) goToHistory(historyIndex + 1);
  };

  const reloadOrStop = () => {
    if (HAS_WEBVIEW) {
      if (loading) webviewRef.current?.stop();
      else webviewRef.current?.reload();
      return;
    }
    // An iframe load cannot be cancelled from the outside; remounting it is the
    // only reload an embedder gets.
    if (loading) setLoading(false);
    else if (url !== 'about:blank') { setReloadKey((k) => k + 1); setLoading(true); }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') navigate(inputUrl);
  };

  const applyPreset = useCallback((preset: ViewportPreset) => {
    setActivePreset(preset.id);
    setLockedSize({ w: preset.w, h: preset.h });
    onApplyWidth(preset.w);
  }, [onApplyWidth]);

  const clearPreset = useCallback(() => {
    setActivePreset(null);
    setLockedSize(null);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    setActivePreset(null);
    setLockedSize(null);
  }, [isDragging]);

  const showOverlay = isDragging || size.w > 0;
  const dimLabel = `${size.w} x ${size.h}`;

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <button
          className="browser-nav-btn"
          onClick={goBack}
          disabled={!canGoBack}
        >Back</button>
        <button
          className="browser-nav-btn"
          onClick={goForward}
          disabled={!canGoForward}
        >Forward</button>
        <button
          className="browser-nav-btn"
          onClick={reloadOrStop}
        >{loading ? 'Stop' : 'Reload'}</button>
        <div className="browser-url-wrap">
          <input
            className="browser-url-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={(e) => e.target.select()}
            placeholder="Search or enter address"
            spellCheck={false}
          />
        </div>
        <div
          className={`browser-dim-badge${isDragging ? ' browser-dim-badge-live' : ''}`}
          title="Viewport size"
        >
          {dimLabel}
        </div>
        <button
          type="button"
          className={`browser-nav-btn browser-presets-toggle${showPresets ? ' active' : ''}`}
          onClick={togglePresets}
          title={showPresets ? 'Hide viewport presets' : 'Show viewport presets'}
        >
          Presets
        </button>
      </div>

      {showPresets && (
        <div className="browser-preset-bar">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`browser-preset-btn${activePreset === p.id ? ' active' : ''}`}
              title={`${p.label}: ${p.w} x ${p.h}`}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
          {lockedSize && (
            <button
              type="button"
              className="browser-preset-btn browser-preset-clear"
              onClick={clearPreset}
              title="Fill panel (no fixed viewport)"
            >
              Fluid
            </button>
          )}
        </div>
      )}

      <div className="browser-viewport-stage">
        {showOverlay && isDragging && (
          <div className="browser-dim-overlay">{dimLabel}</div>
        )}
        <div
          ref={viewportRef}
          className={`browser-viewport${lockedSize ? ' browser-viewport-locked' : ''}`}
          style={
            lockedSize
              ? { width: lockedSize.w, height: lockedSize.h }
              : undefined
          }
        >
          {HAS_WEBVIEW ? (
            <webview
              ref={webviewRef as React.RefObject<HTMLElement>}
              src={url}
              className="browser-webview"
              style={{ flex: 1, minHeight: 0, width: '100%', height: '100%', display: 'flex' } as React.CSSProperties}
            />
          ) : (
            <iframe
              key={reloadKey}
              ref={iframeRef}
              src={url}
              className="browser-webview"
              title="Browser preview"
              onLoad={() => setLoading(false)}
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals allow-downloads"
              style={{ flex: 1, minHeight: 0, width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
