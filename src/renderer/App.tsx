import React, { useState, useCallback, useEffect, useRef } from 'react';
import Workspace, { WorkspaceApi } from './components/Workspace';
import { AgentInstance, WorkspaceInfo } from '../shared/types';

const STORAGE_KEY = 'launcher-workspaces-v1';
const SESSION_KEY = 'launcher-session-alive';

interface StoredWorkspace {
  id: string;
  name: string;
  hasOwnConfig: boolean;
}

interface WsState extends StoredWorkspace {
  configDir?: string;
}

const DEFAULT_WS: StoredWorkspace = { id: 'default', name: 'Workspace 1', hasOwnConfig: false };

function loadStored(): { list: StoredWorkspace[]; activeId: string } {
  try {
    // Workspaces live only as long as the app: every launch starts clean with
    // the single default workspace. sessionStorage survives an in-window
    // reload but not an app restart, so it tells the two apart — the stored
    // list is only restored mid-session, never across launches.
    if (!sessionStorage.getItem(SESSION_KEY)) {
      sessionStorage.setItem(SESSION_KEY, '1');
      localStorage.removeItem(STORAGE_KEY);
      return { list: [DEFAULT_WS], activeId: DEFAULT_WS.id };
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { list?: StoredWorkspace[]; activeId?: string };
      if (Array.isArray(parsed.list) && parsed.list.length > 0) {
        // Workspaces saved before per-workspace configs existed have no
        // hasOwnConfig flag — treat them as isolated (own config dir) so they
        // stop sharing the global Claude account. Only 'default' keeps it.
        const list = parsed.list
          .filter((w) => w && w.id && w.name)
          .map((w) => ({
            ...w,
            hasOwnConfig: typeof w.hasOwnConfig === 'boolean' ? w.hasOwnConfig : w.id !== 'default',
          }));
        if (list.length > 0) {
          const activeId = list.some((w) => w.id === parsed.activeId) ? String(parsed.activeId) : list[0].id;
          return { list, activeId };
        }
      }
    }
  } catch (_e) {}
  return { list: [DEFAULT_WS], activeId: DEFAULT_WS.id };
}

export default function App(): JSX.Element {
  const stored = useRef(loadStored());
  const [workspaces, setWorkspaces] = useState<WsState[]>(stored.current.list);
  const [activeId, setActiveId] = useState(stored.current.activeId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const agentsByWs = useRef<Map<string, AgentInstance[]>>(new Map());
  const apisRef = useRef<Map<string, WorkspaceApi>>(new Map());
  const requestedConfigs = useRef<Set<string>>(new Set());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  useEffect(() => {
    for (const ws of workspaces) {
      if (!ws.hasOwnConfig || ws.configDir || requestedConfigs.current.has(ws.id)) continue;
      requestedConfigs.current.add(ws.id);
      window.electronAPI.ensureWorkspaceConfig(ws.id).then((dir) => {
        setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? { ...w, configDir: dir } : w)));
      });
    }
  }, [workspaces]);

  useEffect(() => {
    const list = workspaces.map(({ id, name, hasOwnConfig }) => ({ id, name, hasOwnConfig }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ list, activeId }));
    } catch (_e) {}
  }, [workspaces, activeId]);

  const syncAll = useCallback(() => {
    const flat: AgentInstance[] = [];
    for (const agents of agentsByWs.current.values()) flat.push(...agents);
    window.electronAPI.syncAgents(flat);
  }, []);

  const handleAgentsChange = useCallback((wsId: string, agents: AgentInstance[]) => {
    agentsByWs.current.set(wsId, agents);
    syncAll();
  }, [syncAll]);

  const registerApi = useCallback((wsId: string, api: WorkspaceApi | null) => {
    if (api) apisRef.current.set(wsId, api);
    else apisRef.current.delete(wsId);
  }, []);

  useEffect(() => {
    const offAdd = window.electronAPI.onControlAddAgent((requestId, type) => {
      const api = apisRef.current.get(activeIdRef.current) || apisRef.current.values().next().value;
      if (!api) return;
      const agent = api.addAgent(type);
      window.electronAPI.controlAddAgentResult(requestId, agent);
    });
    const offRemove = window.electronAPI.onControlRemoveAgent((id) => {
      for (const api of apisRef.current.values()) api.removeAgent(id);
    });
    return () => { offAdd(); offRemove(); };
  }, []);

  const addWorkspace = async () => {
    const id = `ws-${Date.now()}`;
    const name = `Workspace ${workspaces.length + 1}`;
    const dir = await window.electronAPI.ensureWorkspaceConfig(id);
    requestedConfigs.current.add(id);
    setWorkspaces((prev) => [...prev, { id, name, hasOwnConfig: true, configDir: dir }]);
    setActiveId(id);
  };

  const removeWorkspace = (id: string) => {
    if (workspaces.length <= 1) return;
    agentsByWs.current.delete(id);
    syncAll();
    const next = workspaces.filter((w) => w.id !== id);
    setWorkspaces(next);
    if (activeId === id && next.length > 0) setActiveId(next[0].id);
  };

  const startRename = (ws: WsState) => {
    setEditingId(ws.id);
    setDraft(ws.name);
  };

  const commitRename = () => {
    const name = draft.trim().slice(0, 40);
    if (editingId && name) {
      setWorkspaces((prev) => prev.map((w) => (w.id === editingId ? { ...w, name } : w)));
    }
    setEditingId(null);
  };

  return (
    <div className="shell">
      <div className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">WORKSPACES</span>
          <button className="sidebar-add" title="Add workspace" onClick={addWorkspace}>+</button>
        </div>
        <div className="sidebar-list">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className={`ws-item${ws.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(ws.id)}
              onDoubleClick={() => startRename(ws)}
            >
              {editingId === ws.id ? (
                <input
                  className="ws-name-input"
                  value={draft}
                  autoFocus
                  maxLength={40}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="ws-name" title="Double-click to rename">{ws.name}</span>
              )}
              {workspaces.length > 1 && (
                <button
                  className="ws-delete"
                  title="Delete workspace"
                  onClick={(e) => { e.stopPropagation(); removeWorkspace(ws.id); }}
                >x</button>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="shell-main">
        {workspaces.map((ws) => {
          const info: WorkspaceInfo = { id: ws.id, name: ws.name, configDir: ws.configDir };
          return (
            <div key={ws.id} className="ws-host" style={{ display: ws.id === activeId ? 'flex' : 'none' }}>
              <Workspace
                workspace={info}
                active={ws.id === activeId}
                onAgentsChange={handleAgentsChange}
                registerApi={registerApi}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
