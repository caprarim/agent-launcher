import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FsEntry } from '../../shared/types';

interface Props {
  rootPath: string;
  onClose: () => void;
}

interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

interface TreeNode {
  entry: FsEntry;
  children?: TreeNode[];
  expanded?: boolean;
}

function TreeItem({
  node, depth, selectedPath, onSelect, onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (entry: FsEntry) => void;
  onToggle: (entry: FsEntry) => void;
}) {
  const { entry } = node;
  const selected = selectedPath === entry.path;
  return (
    <>
      <div
        className={`tree-item ${selected ? 'selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => entry.isDirectory ? onToggle(entry) : onSelect(entry)}
      >
        <span className="tree-chevron">
          {entry.isDirectory ? (node.expanded ? '-' : '+') : ' '}
        </span>
        <span className="tree-name">{entry.name}</span>
      </div>
      {entry.isDirectory && node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.entry.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

export default function EditorPanel({ rootPath, onClose }: Props): JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    const result = await window.electronAPI.fsReadDir(dirPath);
    return result.entries.map((e) => ({ entry: e }));
  }, []);

  useEffect(() => {
    if (!rootPath) return;
    loadDir(rootPath).then(setTree);
  }, [rootPath, loadDir]);

  const handleToggle = useCallback(async (entry: FsEntry) => {
    const toggle = async (nodes: TreeNode[]): Promise<TreeNode[]> =>
      Promise.all(nodes.map(async (n) => {
        if (n.entry.path !== entry.path) {
          return { ...n, children: n.children ? await toggle(n.children) : undefined };
        }
        if (n.expanded) return { ...n, expanded: false };
        const children = await loadDir(entry.path);
        return { ...n, expanded: true, children };
      }));
    setTree(await toggle(tree));
  }, [tree, loadDir]);

  const handleSelect = useCallback(async (entry: FsEntry) => {
    if (openFile) await window.electronAPI.fsUnwatch(openFile.path);
    const result = await window.electronAPI.fsReadFile(entry.path);
    setOpenFile({ path: entry.path, name: entry.name, content: result.content, dirty: false });
    setSaveStatus('saved');
    await window.electronAPI.fsWatch(entry.path);
  }, [openFile]);

  useEffect(() => {
    const unsub = window.electronAPI.onFsChanged(async (changedPath) => {
      if (!openFile || changedPath !== openFile.path || openFile.dirty) return;
      const result = await window.electronAPI.fsReadFile(changedPath);
      setOpenFile((prev) => prev ? { ...prev, content: result.content } : null);
    });
    return unsub;
  }, [openFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const content = e.target.value;
    setOpenFile((prev) => prev ? { ...prev, content, dirty: true } : null);
    setSaveStatus('unsaved');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      if (!openFile) return;
      setSaveStatus('saving');
      const result = await window.electronAPI.fsWriteFile(openFile.path, content);
      setSaveStatus(result.success ? 'saved' : 'error');
      setOpenFile((prev) => prev ? { ...prev, dirty: false } : null);
    }, 800);
  }, [openFile]);

  const handleKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (!openFile) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveStatus('saving');
      const result = await window.electronAPI.fsWriteFile(openFile.path, openFile.content);
      setSaveStatus(result.success ? 'saved' : 'error');
      setOpenFile((prev) => prev ? { ...prev, dirty: false } : null);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current!;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newContent = openFile!.content.slice(0, start) + '  ' + openFile!.content.slice(end);
      setOpenFile((prev) => prev ? { ...prev, content: newContent, dirty: true } : null);
      setSaveStatus('unsaved');
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
    }
  }, [openFile]);

  useEffect(() => {
    return () => { if (openFile) window.electronAPI.fsUnwatch(openFile.path); };
  }, [openFile]);

  const statusLabel = { saved: 'Saved', saving: 'Saving', unsaved: 'Unsaved', error: 'Error' }[saveStatus];

  return (
    <div className="editor-panel">
      <div className="editor-header">
        <span className="editor-title">
          {openFile ? (
            <>
              <span className="editor-filename">{openFile.name}</span>
              <span className={`editor-save-status ${saveStatus}`}>{statusLabel}</span>
            </>
          ) : (
            <span className="editor-hint">Select a file to edit</span>
          )}
        </span>
      </div>
      <div className="editor-body">
        <div className="editor-tree">
          <div className="editor-tree-root">
            {rootPath ? rootPath.split(/[\\/]/).pop() : 'Files'}
          </div>
          {tree.length === 0 && <div className="editor-tree-empty">No project path set</div>}
          {tree.map((node) => (
            <TreeItem
              key={node.entry.path}
              node={node}
              depth={0}
              selectedPath={openFile?.path ?? ''}
              onSelect={handleSelect}
              onToggle={handleToggle}
            />
          ))}
        </div>
        <div className="editor-code-wrap">
          {openFile ? (
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={openFile.content}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          ) : (
            <div className="editor-no-file"><span>Open a file from the tree</span></div>
          )}
        </div>
      </div>
    </div>
  );
}
