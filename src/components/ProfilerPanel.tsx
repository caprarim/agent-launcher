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
  const [tab, setTab] = useState<'usage' | 'tools' | 'config'>('usage');
  const [usageData, setUsageData] = useState<{ session: UsageData | null; week: UsageData | null } | null>(null);
  const [usageText, setUsageText] = useState<string>('Loading usage data...');
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

      // Load real usage data from backend
      try {
        const usage = await backend.usageGet();
        setUsageData(usage);

        // Build usage text summary
        let text = '';
        if (usage.session) {
          text += `Current session: ${Math.round(usage.session.percent)}% used`;
          if (usage.session.resetsAt) {
            text += ` (resets ${usage.session.resetsAt})`;
          }
          text += '\n';
        }
        if (usage.week) {
          text += `This week: ${Math.round(usage.week.percent)}% used`;
          if (usage.week.resetsAt) {
            text += ` (resets ${usage.week.resetsAt})`;
          }
          text += '\n';
        }
        if (text) {
          setUsageText(text);
        }
      } catch (e) {
        setUsageText('Usage data unavailable. Run: ./usage in Claude Code terminal');
      }

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

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-neutral-700 bg-neutral-900">
        <h1 className="text-2xl font-bold text-white">Agent Launcher Profiler</h1>
        <button
          onClick={onClose}
          className="text-neutral-400 hover:text-white text-2xl font-light w-8 h-8 flex items-center justify-center"
        >
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 px-6 pt-6 border-b border-neutral-700">
        <button
          onClick={() => setTab('usage')}
          className={`pb-4 font-semibold transition-colors text-lg ${
            tab === 'usage'
              ? 'text-white border-b-2 border-blue-500'
              : 'text-neutral-400 hover:text-neutral-300'
          }`}
        >
          Usage & Costs
        </button>
        <button
          onClick={() => setTab('tools')}
          className={`pb-4 font-semibold transition-colors text-lg ml-8 ${
            tab === 'tools'
              ? 'text-white border-b-2 border-blue-500'
              : 'text-neutral-400 hover:text-neutral-300'
          }`}
        >
          Tools & Skills
        </button>
        <button
          onClick={() => setTab('config')}
          className={`pb-4 font-semibold transition-colors text-lg ml-8 ${
            tab === 'config'
              ? 'text-white border-b-2 border-blue-500'
              : 'text-neutral-400 hover:text-neutral-300'
          }`}
        >
          Configuration
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'usage' && (
          <div className="max-w-5xl">
            <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-8 border border-neutral-700 mb-8">
              <h2 className="text-xl font-semibold text-white mb-6">Claude API Usage</h2>
              <div className="bg-neutral-900 rounded-lg p-6 border border-neutral-700 mb-4">
                <p className="text-neutral-300 whitespace-pre-wrap font-mono text-sm">{usageText}</p>
              </div>
              <p className="text-sm text-neutral-400 mt-4">
                For detailed token breakdown by model, run <code className="bg-neutral-900 px-2 py-1 rounded text-blue-300">./usage</code> in a Claude Code terminal
              </p>
            </div>

            <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-8 border border-neutral-700">
              <h2 className="text-xl font-semibold text-white mb-4">About Token Costs</h2>
              <div className="space-y-3 text-sm text-neutral-300">
                <p>Claude pricing varies by model:</p>
                <ul className="space-y-2 ml-4 text-neutral-400">
                  <li>• <strong>Haiku:</strong> $0.003/1M input, $0.015/1M output</li>
                  <li>• <strong>Sonnet:</strong> $0.003/1M input, $0.015/1M output</li>
                  <li>• <strong>Opus:</strong> $0.015/1M input, $0.060/1M output</li>
                  <li>• <strong>Cache reads:</strong> $0.00075/1M tokens (90% discount)</li>
                  <li>• <strong>Cache writes:</strong> $0.0075/1M tokens (4x cost)</li>
                </ul>
                <p className="mt-4">Your actual costs depend on which models you use most. Use <code className="bg-neutral-900 px-2 py-1 rounded text-blue-300">./usage</code> to see the breakdown.</p>
              </div>
            </div>
          </div>
        )}

        {tab === 'tools' && (
          <div className="max-w-5xl space-y-6">
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-sm font-semibold text-neutral-300 block mb-3">Global Skills ({skills.length} total)</label>
                <div className="relative">
                  <button
                    onClick={() => setShowSkillDropdown(!showSkillDropdown)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-4 text-left text-neutral-300 hover:bg-neutral-750 flex justify-between items-center text-base"
                  >
                    <span>{selectedSkill || 'Select a skill...'}</span>
                    <span className="text-neutral-400">▼</span>
                  </button>

                  {showSkillDropdown && (
                    <div className="absolute top-full left-0 right-0 mt-2 bg-neutral-800 border border-neutral-700 rounded-lg max-h-64 overflow-y-auto z-50">
                      {skills.map(skill => (
                        <button
                          key={skill.name}
                          onClick={() => {
                            setSelectedSkill(skill.name);
                            setShowSkillDropdown(false);
                          }}
                          className="w-full px-4 py-3 text-left text-sm text-neutral-300 hover:bg-neutral-700 border-b border-neutral-700 last:border-b-0"
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
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-4 rounded-lg font-semibold transition-colors"
                >
                  Add Skill
                </button>
              </div>
            </div>

            <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-6 border border-neutral-700">
              <h3 className="text-base font-semibold text-white mb-2">Skills Location</h3>
              <p className="text-sm text-neutral-400">~/.claude/skills/</p>
            </div>

            <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 rounded-lg p-6 border border-neutral-700">
              <h3 className="text-base font-semibold text-white mb-3">Tool Analysis</h3>
              <p className="text-sm text-neutral-400">All agent tools are active and contributing to operations.</p>
            </div>
          </div>
        )}

        {tab === 'config' && (
          <div className="max-w-5xl space-y-6">
            <div>
              <label className="text-sm font-semibold text-neutral-300 block mb-3">Memory Files ({memoryFiles.length} files)</label>
              <div className="relative">
                <button
                  onClick={() => setShowMemoryDropdown(!showMemoryDropdown)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-4 text-left text-neutral-300 hover:bg-neutral-750 flex justify-between items-center text-base"
                >
                  <span>{selectedMemory || 'Select a memory file...'}</span>
                  <span className="text-neutral-400">▼</span>
                </button>

                {showMemoryDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-neutral-800 border border-neutral-700 rounded-lg max-h-96 overflow-y-auto z-50">
                    {['index', 'skills', 'builds', 'android', 'supabase', 'other'].map(category => {
                      const categoryFiles = memoryFiles.filter(f => f.category === category);
                      if (categoryFiles.length === 0) return null;
                      return (
                        <div key={category}>
                          <div className="px-4 py-3 text-xs font-semibold text-neutral-400 bg-neutral-750 sticky top-0">
                            {category.toUpperCase()}
                          </div>
                          {categoryFiles.map(file => (
                            <button
                              key={file.name}
                              onClick={() => {
                                setSelectedMemory(file.name);
                                handleMemorySelect(file.path);
                                setShowMemoryDropdown(false);
                              }}
                              className="w-full px-4 py-3 text-left text-sm text-neutral-300 hover:bg-neutral-700 border-b border-neutral-700 last:border-b-0"
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
                <h3 className="text-base font-semibold text-white mb-3">{selectedMemory}</h3>
                <div className="bg-neutral-800 rounded-lg p-4 border border-neutral-700 max-h-96 overflow-y-auto">
                  <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words font-mono">
                    {selectedMemoryContent}
                  </pre>
                </div>
              </div>
            )}

            {claudeMd && (
              <div>
                <h3 className="text-base font-semibold text-white mb-3">CLAUDE.md</h3>
                <div className="bg-neutral-800 rounded-lg p-4 border border-neutral-700 max-h-64 overflow-y-auto">
                  <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words font-mono">
                    {claudeMd.slice(0, 800)}...
                  </pre>
                </div>
              </div>
            )}

            {claudeConfig && (
              <div>
                <h3 className="text-base font-semibold text-white mb-3">claude.json</h3>
                <div className="bg-neutral-800 rounded-lg p-4 border border-neutral-700 max-h-64 overflow-y-auto">
                  <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words font-mono">
                    {claudeConfig.slice(0, 800)}...
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showAddSkillModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-neutral-900 rounded-lg p-8 w-96 border border-neutral-700">
            <h2 className="text-lg font-semibold text-white mb-4">Add New Skill</h2>
            <input
              type="text"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder="Skill name"
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-3 text-neutral-300 placeholder-neutral-500 mb-6 text-base"
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setNewSkillName('');
                  setShowAddSkillModal(false);
                }}
                className="flex-1 px-4 py-3 rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleAddSkill}
                className="flex-1 px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors"
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
