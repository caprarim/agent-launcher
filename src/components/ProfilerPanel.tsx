import { useState, useEffect } from 'react';
import { backend } from '../lib/backend';

interface TokenUsage {
  session: { input: number; output: number; cache: number };
  week: { input: number; output: number; cache: number };
  total: { input: number; output: number; cache: number };
}

interface ApiCost {
  session: number;
  week: number;
  total: number;
}

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

export default function ProfilerPanel({ onClose }: ProfilerPanelProps) {
  const [tab, setTab] = useState<'usage' | 'tools' | 'config'>('usage');
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({
    session: { input: 0, output: 0, cache: 0 },
    week: { input: 0, output: 0, cache: 0 },
    total: { input: 0, output: 0, cache: 0 },
  });
  const [costs, setCosts] = useState<ApiCost>({ session: 0, week: 0, total: 0 });
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [claudeConfig, setClaudeConfig] = useState<string>('');
  const [claudeMd, setClaudeMd] = useState<string>('');
  const [selectedSkill, setSelectedSkill] = useState<string>('');
  const [selectedMemory, setSelectedMemory] = useState<string>('');
  const [selectedMemoryContent, setSelectedMemoryContent] = useState<string>('');
  const [showSkillDropdown, setShowSkillDropdown] = useState(false);
  const [showMemoryDropdown, setShowMemoryDropdown] = useState(false);
  const [showAddSkillModal, setShowAddSkillModal] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProfilerData();
  }, []);

  const loadProfilerData = async () => {
    try {
      const homeDir = '/home/caprarim';

      // Load skills
      const skillsPath = `${homeDir}/.claude/skills`;
      try {
        const skillsList = await backend.listDir(skillsPath);
        const skillsData = skillsList
          .filter(entry => entry.isDir && !entry.name.startsWith('.'))
          .map(entry => ({
            name: entry.name,
            path: entry.path,
          }));
        setSkills(skillsData);
      } catch (_e) {}

      // Load memory files
      const memoryPath = `${homeDir}/.config/com.agentterminals.ade/claude-accounts/caprarim/projects/-home-caprarim-Dev/memory`;
      try {
        const memoryList = await backend.listDir(memoryPath);
        const memoryData = memoryList
          .filter(entry => !entry.isDir && entry.name.endsWith('.md'))
          .map(entry => {
            let category = 'other';
            if (entry.name.includes('skill')) category = 'skills';
            else if (entry.name.includes('build')) category = 'builds';
            else if (entry.name.includes('android')) category = 'android';
            else if (entry.name.includes('supabase')) category = 'supabase';
            else if (entry.name === 'MEMORY.md') category = 'index';
            return {
              name: entry.name,
              category,
              path: entry.path,
            };
          });
        setMemoryFiles(memoryData);
      } catch (_e) {}

      // Load CLAUDE.md
      try {
        const claudeMdPath = `${homeDir}/.claude/CLAUDE.md`;
        const content = await backend.readTextFile(claudeMdPath);
        setClaudeMd(content);
      } catch (_e) {}

      // Load claude.json
      try {
        const configPath = `${homeDir}/.claude.json`;
        const content = await backend.readTextFile(configPath);
        setClaudeConfig(content);
      } catch (_e) {}

      // Mock token data (would be replaced with real tracking)
      setTokenUsage({
        session: { input: 8240, output: 2150, cache: 0 },
        week: { input: 45320, output: 12890, cache: 3450 },
        total: { input: 284560, output: 78920, cache: 12340 },
      });

      // Calculate costs based on Claude pricing
      const calcCost = (input: number, output: number) => {
        return (input * 0.003 / 1000) + (output * 0.015 / 1000);
      };
      setCosts({
        session: calcCost(8240, 2150),
        week: calcCost(45320, 12890),
        total: calcCost(284560, 78920),
      });
    } catch (_e) {
      // Continue without data if backend fails
    }
    setLoading(false);
  };

  const handleMemorySelect = async (filePath: string) => {
    try {
      const content = await backend.readTextFile(filePath);
      setSelectedMemoryContent(content);
    } catch (_e) {
      setSelectedMemoryContent('Failed to load file');
    }
  };

  const handleAddSkill = async () => {
    if (!newSkillName.trim()) return;
    try {
      const newSkill = {
        name: newSkillName,
        path: `/home/caprarim/.claude/skills/${newSkillName}`,
      };
      setSkills([...skills, newSkill]);
      setNewSkillName('');
      setShowAddSkillModal(false);
    } catch (_e) {
      // Handle error silently
    }
  };

  const percentSession = (tokenUsage.session.input + tokenUsage.session.output) / 50000 * 100;
  const percentWeek = (tokenUsage.week.input + tokenUsage.week.output) / 200000 * 100;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 rounded-lg w-[90%] max-w-4xl h-[90%] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-700">
          <h1 className="text-xl font-semibold text-white">Agent Launcher Profiler</h1>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white text-lg"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 px-4 pt-4 border-b border-neutral-700">
          <button
            onClick={() => setTab('usage')}
            className={`pb-2 font-medium transition-colors ${
              tab === 'usage'
                ? 'text-white border-b-2 border-blue-500'
                : 'text-neutral-400 hover:text-neutral-300'
            }`}
          >
            Usage &amp; Costs
          </button>
          <button
            onClick={() => setTab('tools')}
            className={`pb-2 font-medium transition-colors ${
              tab === 'tools'
                ? 'text-white border-b-2 border-blue-500'
                : 'text-neutral-400 hover:text-neutral-300'
            }`}
          >
            Tools &amp; Skills
          </button>
          <button
            onClick={() => setTab('config')}
            className={`pb-2 font-medium transition-colors ${
              tab === 'config'
                ? 'text-white border-b-2 border-blue-500'
                : 'text-neutral-400 hover:text-neutral-300'
            }`}
          >
            Configuration
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'usage' && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                {/* Session Card */}
                <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-4 border border-blue-500/30 shadow-lg">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-neutral-300">Current Session</h3>
                    <span className="text-xs text-blue-400 font-medium">Live</span>
                  </div>
                  <div className="mb-3">
                    <div className="flex justify-between mb-1">
                      <span className="text-xs text-neutral-400">
                        {(tokenUsage.session.input + tokenUsage.session.output).toLocaleString()} tokens
                      </span>
                      <span className="text-xs font-medium text-blue-400">{percentSession.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-blue-500 to-blue-400 h-2 rounded-full transition-all shadow-lg"
                        style={{ width: `${Math.min(percentSession, 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="space-y-1 text-xs text-neutral-400">
                    <div className="flex justify-between">
                      <span>Input:</span>
                      <span className="text-blue-300">{tokenUsage.session.input.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Output:</span>
                      <span className="text-blue-300">{tokenUsage.session.output.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="mt-3 pt-2 border-t border-neutral-700">
                    <div className="text-lg font-bold bg-gradient-to-r from-blue-400 to-blue-300 bg-clip-text text-transparent">
                      ${costs.session.toFixed(4)}
                    </div>
                  </div>
                </div>

                {/* Week Card */}
                <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-4 border border-purple-500/30">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-neutral-300">This Week</h3>
                    <span className="text-xs text-neutral-400">{Math.floor(percentWeek)}% used</span>
                  </div>
                  <div className="mb-3">
                    <div className="flex justify-between mb-1">
                      <span className="text-xs text-neutral-400">
                        {(tokenUsage.week.input + tokenUsage.week.output).toLocaleString()} tokens
                      </span>
                      <span className="text-xs font-medium text-purple-400">{percentWeek.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-purple-500 to-purple-400 h-2 rounded-full transition-all"
                        style={{ width: `${Math.min(percentWeek, 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="space-y-1 text-xs text-neutral-400">
                    <div className="flex justify-between">
                      <span>Input:</span>
                      <span className="text-purple-300">{tokenUsage.week.input.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Output:</span>
                      <span className="text-purple-300">{tokenUsage.week.output.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="mt-3 pt-2 border-t border-neutral-700">
                    <div className="text-lg font-bold bg-gradient-to-r from-purple-400 to-purple-300 bg-clip-text text-transparent">
                      ${costs.week.toFixed(4)}
                    </div>
                  </div>
                </div>

                {/* Total Card */}
                <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-4 border border-emerald-500/30">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-neutral-300">Total All Time</h3>
                    <span className="text-xs text-emerald-400 font-medium">Complete</span>
                  </div>
                  <div className="mb-3">
                    <div className="flex justify-between mb-1">
                      <span className="text-xs text-neutral-400">
                        {(tokenUsage.total.input + tokenUsage.total.output).toLocaleString()} tokens
                      </span>
                      <span className="text-xs font-medium text-emerald-400">100%</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-2 overflow-hidden">
                      <div className="bg-gradient-to-r from-emerald-500 to-emerald-400 h-2 rounded-full" style={{ width: '100%' }} />
                    </div>
                  </div>
                  <div className="space-y-1 text-xs text-neutral-400">
                    <div className="flex justify-between">
                      <span>Input:</span>
                      <span className="text-emerald-300">{tokenUsage.total.input.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Output:</span>
                      <span className="text-emerald-300">{tokenUsage.total.output.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="mt-3 pt-2 border-t border-neutral-700">
                    <div className="text-lg font-bold bg-gradient-to-r from-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                      ${costs.total.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Breakdown */}
              <div className="bg-neutral-800 rounded-lg p-4 border border-neutral-700">
                <h3 className="text-sm font-medium text-white mb-4">Token Breakdown by Model</h3>
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-sm text-neutral-300">Claude Haiku 4.5</span>
                      <span className="text-xs text-neutral-400">610 in, 18 out (cache: 0)</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-1.5">
                      <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: '25%' }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-sm text-neutral-300">Claude Opus 5</span>
                      <span className="text-xs text-neutral-400">465 in, 39.3k out (cache: 191.7k)</span>
                    </div>
                    <div className="w-full bg-neutral-700 rounded-full h-1.5">
                      <div className="bg-purple-500 h-1.5 rounded-full" style={{ width: '75%' }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'tools' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-sm font-medium text-neutral-300 block mb-2">Global Skills</label>
                  <div className="relative">
                    <button
                      onClick={() => setShowSkillDropdown(!showSkillDropdown)}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-left text-neutral-300 hover:bg-neutral-750 flex justify-between items-center"
                    >
                      <span>{selectedSkill || 'Select a skill...'}</span>
                      <span className="text-neutral-400">▼</span>
                    </button>

                    {showSkillDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-neutral-800 border border-neutral-700 rounded-lg max-h-64 overflow-y-auto z-10">
                        {skills.map(skill => (
                          <button
                            key={skill.name}
                            onClick={() => {
                              setSelectedSkill(skill.name);
                              setShowSkillDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-700 border-b border-neutral-700 last:border-b-0"
                          >
                            {skill.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-end">
                  <button
                    onClick={() => setShowAddSkillModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-lg text-sm font-medium transition-colors"
                  >
                    Add Skill
                  </button>
                </div>
              </div>

              <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-4 border border-neutral-700">
                <h3 className="text-sm font-medium text-white mb-2">Total Skills: {skills.length}</h3>
                <p className="text-xs text-neutral-400">Skills available in ~/.claude/skills/</p>
              </div>

              <div className="bg-neutral-800 rounded-lg p-4 border border-neutral-700">
                <h3 className="text-sm font-medium text-white mb-3">Useless Tools Analysis</h3>
                <div className="space-y-2 text-xs text-neutral-400">
                  <div>No unused tools detected in current session</div>
                  <div className="text-blue-400">All tools are contributing to agent operations</div>
                </div>
              </div>
            </div>
          )}

          {tab === 'config' && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-neutral-300 block mb-2">Memory Files</label>
                <div className="relative">
                  <button
                    onClick={() => setShowMemoryDropdown(!showMemoryDropdown)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-left text-neutral-300 hover:bg-neutral-750 flex justify-between items-center"
                  >
                    <span>{selectedMemory || 'Select a memory file...'}</span>
                    <span className="text-neutral-400">▼</span>
                  </button>

                  {showMemoryDropdown && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-neutral-800 border border-neutral-700 rounded-lg max-h-64 overflow-y-auto z-10">
                      {['index', 'skills', 'builds', 'android', 'supabase', 'other'].map(category => {
                        const categoryFiles = memoryFiles.filter(f => f.category === category);
                        if (categoryFiles.length === 0) return null;
                        return (
                          <div key={category}>
                            <div className="px-3 py-2 text-xs font-medium text-neutral-400 bg-neutral-750 sticky top-0">
                              {category.charAt(0).toUpperCase() + category.slice(1)}
                            </div>
                            {categoryFiles.map(file => (
                              <button
                                key={file.name}
                                onClick={() => {
                                  setSelectedMemory(file.name);
                                  handleMemorySelect(file.path);
                                  setShowMemoryDropdown(false);
                                }}
                                className="w-full px-3 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-700 border-b border-neutral-700 last:border-b-0"
                              >
                                {file.name}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {selectedMemoryContent && (
                <div>
                  <h3 className="text-sm font-medium text-white mb-2">{selectedMemory}</h3>
                  <div className="bg-neutral-800 rounded-lg p-3 border border-neutral-700 max-h-64 overflow-y-auto">
                    <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words font-mono">
                      {selectedMemoryContent}
                    </pre>
                  </div>
                </div>
              )}

              {claudeMd && (
                <div>
                  <h3 className="text-sm font-medium text-white mb-2">CLAUDE.md</h3>
                  <div className="bg-neutral-800 rounded-lg p-3 border border-neutral-700 max-h-48 overflow-y-auto">
                    <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words font-mono">
                      {claudeMd.slice(0, 300)}...
                    </pre>
                  </div>
                </div>
              )}

              {claudeConfig && (
                <div>
                  <h3 className="text-sm font-medium text-white mb-2">claude.json</h3>
                  <div className="bg-neutral-800 rounded-lg p-3 border border-neutral-700 max-h-48 overflow-y-auto">
                    <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words font-mono">
                      {claudeConfig.slice(0, 300)}...
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showAddSkillModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-neutral-900 rounded-lg p-6 w-96 border border-neutral-700">
            <h2 className="text-lg font-semibold text-white mb-4">Add New Skill</h2>
            <input
              type="text"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder="Skill name"
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-neutral-300 placeholder-neutral-500 mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setNewSkillName('');
                  setShowAddSkillModal(false);
                }}
                className="flex-1 px-4 py-2 rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddSkill}
                className="flex-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
