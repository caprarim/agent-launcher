import { useState, useEffect } from 'react';
import { backend } from '../lib/backend';

interface SkillInfo {
  name: string;
  path: string;
}

interface MemoryFile {
  name: string;
  category: string;
  path: string;
}

interface ProfilerPanelProps {
  onClose?: () => void;
}

interface UsageData {
  percent: number;
  resetsAt: string | null;
}

export default function ProfilerPanel({ onClose }: ProfilerPanelProps) {
  const [tab, setTab] = useState('usage');
  const [usageData, setUsageData] = useState<{ session: UsageData | null; week: UsageData | null } | null>(null);
  const [usageText, setUsageText] = useState<string>('Loading usage data...');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [claudeConfig, setClaudeConfig] = useState<string>('');
  const [claudeMd, setClaudeMd] = useState<string>('');
  const [selectedMemory, setSelectedMemory] = useState<string>('');
  const [selectedMemoryContent, setSelectedMemoryContent] = useState<string>('');
  const [newSkillName, setNewSkillName] = useState('');
  const [showAddSkillDialog, setShowAddSkillDialog] = useState(false);

  useEffect(() => {
    loadProfilerData();
  }, []);

  const loadProfilerData = async () => {
    try {
      const homeDir = '/home/caprarim';

      try {
        const usage = await backend.usageGet();
        setUsageData(usage);

        let text = '';
        if (usage.session) {
          text += `Current session: ${Math.round(usage.session.percent)}% used`;
          if (usage.session.resetsAt) text += ` (resets ${usage.session.resetsAt})`;
          text += '\n';
        }
        if (usage.week) {
          text += `This week: ${Math.round(usage.week.percent)}% used`;
          if (usage.week.resetsAt) text += ` (resets ${usage.week.resetsAt})`;
          text += '\n';
        }
        setUsageText(text || 'Usage data loading...');
      } catch (e) {
        setUsageText('Run "./usage" in Claude Code terminal for detailed breakdown');
      }

      const skillsPath = `${homeDir}/.claude/skills`;
      try {
        const skillsList = await backend.listDir(skillsPath);
        setSkills(skillsList.filter(e => e.isDir && !e.name.startsWith('.')).map(e => ({ name: e.name, path: e.path })));
      } catch (_e) {}

      const memoryPath = `${homeDir}/.config/com.agentterminals.ade/claude-accounts/caprarim/projects/-home-caprarim-Dev/memory`;
      try {
        const memoryList = await backend.listDir(memoryPath);
        setMemoryFiles(memoryList
          .filter(e => !e.isDir && e.name.endsWith('.md'))
          .map(e => {
            let category = 'other';
            if (e.name.includes('skill')) category = 'skills';
            else if (e.name.includes('build')) category = 'builds';
            else if (e.name.includes('android')) category = 'android';
            else if (e.name.includes('supabase')) category = 'supabase';
            else if (e.name === 'MEMORY.md') category = 'index';
            return { name: e.name, category, path: e.path };
          }));
      } catch (_e) {}

      try {
        const content = await backend.readTextFile(`${homeDir}/.claude/CLAUDE.md`);
        setClaudeMd(content);
      } catch (_e) {}

      try {
        const content = await backend.readTextFile(`${homeDir}/.claude.json`);
        setClaudeConfig(content);
      } catch (_e) {}
    } catch (_e) {}
  };

  const handleMemorySelect = async (filePath: string) => {
    try {
      const content = await backend.readTextFile(filePath);
      setSelectedMemoryContent(content);
    } catch (_e) {
      setSelectedMemoryContent('Failed to load file');
    }
  };

  const handleAddSkill = () => {
    if (!newSkillName.trim()) return;
    setSkills([...skills, { name: newSkillName, path: `/home/caprarim/.claude/skills/${newSkillName}` }]);
    setNewSkillName('');
    setShowAddSkillDialog(false);
  };

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="h-20 border-b border-neutral-800 bg-neutral-950 px-8 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">Profiler</h1>
          <p className="text-xs text-neutral-500">Agent Launcher Dashboard</p>
        </div>
        <button onClick={onClose} className="text-neutral-400 hover:text-white text-2xl w-10 h-10">✕</button>
      </div>

      {/* Tabs */}
      <div className="h-14 border-b border-neutral-800 bg-neutral-950/50 px-8 flex items-center gap-8 flex-shrink-0">
        <button
          onClick={() => setTab('usage')}
          className={`pb-3 font-medium text-sm transition-all border-b-2 ${
            tab === 'usage'
              ? 'text-white border-blue-500'
              : 'text-neutral-400 border-transparent hover:text-neutral-300'
          }`}
        >
          Usage & Costs
        </button>
        <button
          onClick={() => setTab('tools')}
          className={`pb-3 font-medium text-sm transition-all border-b-2 ${
            tab === 'tools'
              ? 'text-white border-blue-500'
              : 'text-neutral-400 border-transparent hover:text-neutral-300'
          }`}
        >
          Tools & Skills
        </button>
        <button
          onClick={() => setTab('config')}
          className={`pb-3 font-medium text-sm transition-all border-b-2 ${
            tab === 'config'
              ? 'text-white border-blue-500'
              : 'text-neutral-400 border-transparent hover:text-neutral-300'
          }`}
        >
          Configuration
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Usage Tab */}
        {tab === 'usage' && (
          <div className="p-8 space-y-6">
            {/* Usage Stats Cards */}
            <div className="grid grid-cols-3 gap-6">
              {/* Session Card */}
              {usageData?.session && (
                <div className="bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-xl border-2 border-blue-500/30 p-6">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-sm font-semibold text-neutral-300">Current Session</h3>
                    <span className="text-xs font-bold text-blue-400">Live</span>
                  </div>
                  <div className="mb-4">
                    <div className="text-3xl font-bold text-white mb-2">{Math.round(usageData.session.percent)}%</div>
                    <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                      <div className="bg-gradient-to-r from-blue-500 to-blue-400 h-2 rounded-full" style={{ width: `${usageData.session.percent}%` }} />
                    </div>
                  </div>
                  {usageData.session.resetsAt && (
                    <div className="text-xs text-neutral-400">Resets: {usageData.session.resetsAt}</div>
                  )}
                </div>
              )}

              {/* Week Card */}
              {usageData?.week && (
                <div className="bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-xl border-2 border-purple-500/30 p-6">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-sm font-semibold text-neutral-300">This Week</h3>
                    <span className="text-xs font-bold text-purple-400">Tracking</span>
                  </div>
                  <div className="mb-4">
                    <div className="text-3xl font-bold text-white mb-2">{Math.round(usageData.week.percent)}%</div>
                    <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                      <div className="bg-gradient-to-r from-purple-500 to-purple-400 h-2 rounded-full" style={{ width: `${usageData.week.percent}%` }} />
                    </div>
                  </div>
                  {usageData.week.resetsAt && (
                    <div className="text-xs text-neutral-400">Resets: {usageData.week.resetsAt}</div>
                  )}
                </div>
              )}

              {/* Info Card */}
              <div className="bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-xl border-2 border-emerald-500/30 p-6">
                <div className="flex justify-between items-start mb-4">
                  <h3 className="text-sm font-semibold text-neutral-300">Status</h3>
                  <span className="text-xs font-bold text-emerald-400">Active</span>
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="text-xs text-neutral-400 mb-1">API Health</div>
                    <div className="text-lg font-bold text-emerald-400">Connected</div>
                  </div>
                  <button
                    onClick={() => setTab('usage')}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2 px-4 rounded-lg transition-colors text-sm mt-4"
                  >
                    View Details
                  </button>
                </div>
              </div>
            </div>

            {/* Pricing Reference */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
              <h2 className="text-lg font-bold text-white mb-6">Pricing Reference</h2>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { model: 'Haiku', input: '$0.003/1M', output: '$0.015/1M', badge: 'Fast' },
                  { model: 'Sonnet', input: '$0.003/1M', output: '$0.015/1M', badge: 'Balanced' },
                  { model: 'Opus', input: '$0.015/1M', output: '$0.060/1M', badge: 'Powerful' },
                ].map(m => (
                  <div key={m.model} className="bg-neutral-950 rounded-lg border border-neutral-800 p-4">
                    <div className="flex justify-between items-start mb-3">
                      <span className="font-semibold text-white">{m.model}</span>
                      <span className="text-xs bg-blue-500/20 text-blue-300 px-2 py-1 rounded">{m.badge}</span>
                    </div>
                    <div className="space-y-1 text-xs text-neutral-400">
                      <div>Input: <span className="text-neutral-200">{m.input}</span></div>
                      <div>Output: <span className="text-neutral-200">{m.output}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tools Tab */}
        {tab === 'tools' && (
          <div className="p-8 space-y-6">
            {/* Skills Card */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h2 className="text-lg font-bold text-white">Global Skills</h2>
                  <p className="text-xs text-neutral-400 mt-1">{skills.length} skills available</p>
                </div>
                <button
                  onClick={() => setShowAddSkillDialog(true)}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-6 rounded-lg transition-colors"
                >
                  + Add Skill
                </button>
              </div>

              {skills.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                  {skills.map(skill => (
                    <div key={skill.name} className="bg-neutral-950 rounded-lg p-3 border border-neutral-800 hover:border-neutral-700 transition-colors">
                      <div className="font-medium text-sm text-white">{skill.name}</div>
                      <div className="text-xs text-neutral-500 mt-1 truncate">{skill.path}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-neutral-400">No skills yet</div>
              )}
            </div>

            {/* Add Skill Dialog */}
            {showAddSkillDialog && (
              <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
                <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-8 w-full max-w-md">
                  <h3 className="text-xl font-bold text-white mb-4">Create New Skill</h3>
                  <input
                    type="text"
                    value={newSkillName}
                    onChange={(e) => setNewSkillName(e.target.value)}
                    placeholder="skill-name"
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-3 text-white placeholder-neutral-500 mb-4 text-sm"
                  />
                  <div className="flex gap-3">
                    <button
                      onClick={() => setShowAddSkillDialog(false)}
                      className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddSkill}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                    >
                      Create
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Tools Status */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
              <h2 className="text-lg font-bold text-white mb-4">Agent Tools</h2>
              <div className="bg-neutral-950 rounded-lg p-4 border border-neutral-800">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-medium text-white">All Tools Active</div>
                    <div className="text-sm text-neutral-400 mt-1">Contributing to operations</div>
                  </div>
                  <span className="bg-emerald-500/20 text-emerald-300 px-3 py-1 rounded-full text-xs font-semibold">Active</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Config Tab */}
        {tab === 'config' && (
          <div className="p-8 space-y-6">
            {/* Memory Files */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
              <h2 className="text-lg font-bold text-white mb-4">Memory Files ({memoryFiles.length})</h2>
              {memoryFiles.length > 0 ? (
                <div className="max-h-64 overflow-y-auto space-y-2">
                  {['index', 'skills', 'builds', 'android', 'supabase', 'other'].map(category => {
                    const files = memoryFiles.filter(f => f.category === category);
                    if (files.length === 0) return null;
                    return (
                      <div key={category}>
                        <div className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-2">{category}</div>
                        <div className="space-y-1 ml-3">
                          {files.map(file => (
                            <button
                              key={file.name}
                              onClick={() => {
                                setSelectedMemory(file.name);
                                handleMemorySelect(file.path);
                              }}
                              className="w-full text-left px-3 py-2 rounded-lg text-sm text-neutral-400 hover:bg-neutral-950 hover:text-neutral-200 transition-colors border border-transparent hover:border-neutral-800"
                            >
                              {file.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-neutral-400">No memory files</div>
              )}
            </div>

            {/* File Viewers */}
            {selectedMemoryContent && (
              <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
                <h3 className="text-base font-bold text-white mb-3">{selectedMemory}</h3>
                <div className="bg-neutral-950 rounded-lg border border-neutral-800 p-4 max-h-48 overflow-y-auto">
                  <code className="text-xs text-neutral-400 whitespace-pre-wrap font-mono">{selectedMemoryContent.slice(0, 500)}</code>
                </div>
              </div>
            )}

            {claudeMd && (
              <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-6">
                <h3 className="text-base font-bold text-white mb-3">CLAUDE.md</h3>
                <div className="bg-neutral-950 rounded-lg border border-neutral-800 p-4 max-h-48 overflow-y-auto">
                  <code className="text-xs text-neutral-400 whitespace-pre-wrap font-mono">{claudeMd.slice(0, 500)}</code>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
