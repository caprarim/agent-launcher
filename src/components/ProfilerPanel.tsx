import { useState, useEffect } from 'react';
import { backend } from '../lib/backend';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProfilerData();
  }, []);

  const loadProfilerData = async () => {
    try {
      const homeDir = '/home/caprarim';

      // Load real usage data
      try {
        const usage = await backend.usageGet();
        setUsageData(usage);

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
    } catch (_e) {}
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
    const newSkill = {
      name: newSkillName,
      path: `/home/caprarim/.claude/skills/${newSkillName}`,
    };
    setSkills([...skills, newSkill]);
    setNewSkillName('');
  };

  return (
    <div className="fixed inset-0 bg-black/95 z-50 flex flex-col">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-950/50 backdrop-blur-sm p-6 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-white">Profiler</h1>
          <p className="text-sm text-neutral-400 mt-1">Agent Launcher Token & Cost Dashboard</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-10 w-10 text-neutral-400 hover:text-white"
        >
          ✕
        </Button>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={tab} onValueChange={setTab} className="h-full flex flex-col">
          <div className="border-b border-neutral-800 bg-neutral-950/30 px-6 pt-6">
            <TabsList className="bg-neutral-900 border border-neutral-800">
              <TabsTrigger value="usage" className="data-[state=active]:bg-neutral-800">
                Usage & Costs
              </TabsTrigger>
              <TabsTrigger value="tools" className="data-[state=active]:bg-neutral-800">
                Tools & Skills
              </TabsTrigger>
              <TabsTrigger value="config" className="data-[state=active]:bg-neutral-800">
                Configuration
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Usage Tab */}
          <TabsContent value="usage" className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6 max-w-5xl">
              <Card className="bg-neutral-900 border-neutral-800">
                <CardHeader>
                  <CardTitle className="text-white">API Usage Overview</CardTitle>
                  <CardDescription>Real-time usage statistics from Claude Code</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="bg-neutral-950 rounded-lg p-4 border border-neutral-800">
                      <code className="text-sm text-neutral-300 whitespace-pre-wrap font-mono">{usageText}</code>
                    </div>
                    {usageData?.session && (
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-neutral-400">Current Session</span>
                          <Badge variant="outline">{Math.round(usageData.session.percent)}% used</Badge>
                        </div>
                        <div className="w-full bg-neutral-800 rounded-full h-2">
                          <div
                            className="bg-blue-500 h-2 rounded-full"
                            style={{ width: `${usageData.session.percent}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {usageData?.week && (
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-neutral-400">This Week</span>
                          <Badge variant="outline" className="border-purple-500/30 text-purple-400">
                            {Math.round(usageData.week.percent)}% used
                          </Badge>
                        </div>
                        <div className="w-full bg-neutral-800 rounded-full h-2">
                          <div
                            className="bg-purple-500 h-2 rounded-full"
                            style={{ width: `${usageData.week.percent}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-neutral-900 border-neutral-800">
                <CardHeader>
                  <CardTitle className="text-white">Pricing Reference</CardTitle>
                  <CardDescription>Claude API costs by model</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {[
                      { name: 'Haiku', input: '$0.003/1M', output: '$0.015/1M', color: 'blue' },
                      { name: 'Sonnet', input: '$0.003/1M', output: '$0.015/1M', color: 'cyan' },
                      { name: 'Opus', input: '$0.015/1M', output: '$0.060/1M', color: 'purple' },
                    ].map(model => (
                      <div key={model.name} className="flex justify-between items-center p-3 bg-neutral-950 rounded-lg border border-neutral-800">
                        <div>
                          <div className="font-medium text-white">{model.name}</div>
                          <div className="text-xs text-neutral-400">Input {model.input} · Output {model.output}</div>
                        </div>
                        <Badge variant="secondary">
                          {model.color === 'blue' && 'Fast'}
                          {model.color === 'cyan' && 'Balanced'}
                          {model.color === 'purple' && 'Powerful'}
                        </Badge>
                      </div>
                    ))}
                    <Separator className="bg-neutral-800 my-4" />
                    <div className="text-xs text-neutral-400 space-y-2">
                      <p>• Cache reads: <strong>$0.00075/1M</strong> (90% discount)</p>
                      <p>• Cache writes: <strong>$0.0075/1M</strong> (4x cost)</p>
                      <p>Run <code className="bg-neutral-950 px-2 py-1 rounded text-blue-300">./usage</code> in Claude Code to see your breakdown</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Tools Tab */}
          <TabsContent value="tools" className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6 max-w-5xl">
              <Card className="bg-neutral-900 border-neutral-800">
                <CardHeader>
                  <CardTitle className="text-white">Global Skills</CardTitle>
                  <CardDescription>{skills.length} skills available</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {skills.length > 0 ? (
                      <ScrollArea className="h-64 rounded-lg border border-neutral-800 bg-neutral-950">
                        <div className="p-4 space-y-2">
                          {skills.map(skill => (
                            <div key={skill.name} className="px-3 py-2 rounded-md hover:bg-neutral-800 transition-colors">
                              <div className="text-sm font-medium text-white">{skill.name}</div>
                              <div className="text-xs text-neutral-500">{skill.path}</div>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    ) : (
                      <div className="text-center py-8 text-neutral-400">
                        No skills yet. Create one to get started.
                      </div>
                    )}
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button className="w-full bg-blue-600 hover:bg-blue-700">
                          Add New Skill
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="bg-neutral-900 border-neutral-800">
                        <DialogHeader>
                          <DialogTitle className="text-white">Create New Skill</DialogTitle>
                          <DialogDescription>Add a new skill to your global skills folder</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor="skill-name" className="text-neutral-300">Skill Name</Label>
                            <Input
                              id="skill-name"
                              placeholder="my-awesome-skill"
                              value={newSkillName}
                              onChange={(e) => setNewSkillName(e.target.value)}
                              className="bg-neutral-800 border-neutral-700 text-white placeholder:text-neutral-500"
                            />
                          </div>
                          <Button
                            onClick={handleAddSkill}
                            className="w-full bg-blue-600 hover:bg-blue-700"
                          >
                            Create Skill
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-neutral-900 border-neutral-800">
                <CardHeader>
                  <CardTitle className="text-white">Agent Tools</CardTitle>
                  <CardDescription>Status and usage</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center p-3 bg-neutral-950 rounded-lg border border-neutral-800">
                      <div>
                        <div className="font-medium text-white">All Tools Active</div>
                        <div className="text-xs text-neutral-400">Contributing to operations</div>
                      </div>
                      <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Active</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Config Tab */}
          <TabsContent value="config" className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6 max-w-5xl">
              <Card className="bg-neutral-900 border-neutral-800">
                <CardHeader>
                  <CardTitle className="text-white">Memory Files</CardTitle>
                  <CardDescription>{memoryFiles.length} files in your memory</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {memoryFiles.length > 0 ? (
                      <ScrollArea className="h-72 rounded-lg border border-neutral-800 bg-neutral-950">
                        <div className="p-4 space-y-4">
                          {['index', 'skills', 'builds', 'android', 'supabase', 'other'].map(category => {
                            const categoryFiles = memoryFiles.filter(f => f.category === category);
                            if (categoryFiles.length === 0) return null;
                            return (
                              <div key={category}>
                                <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                                  {category}
                                </div>
                                <div className="space-y-1 ml-2">
                                  {categoryFiles.map(file => (
                                    <button
                                      key={file.name}
                                      onClick={() => {
                                        setSelectedMemory(file.name);
                                        handleMemorySelect(file.path);
                                      }}
                                      className="w-full text-left px-3 py-2 rounded-md text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                                    >
                                      {file.name}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    ) : (
                      <div className="text-center py-8 text-neutral-400">
                        No memory files yet.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {selectedMemoryContent && (
                <Card className="bg-neutral-900 border-neutral-800">
                  <CardHeader>
                    <CardTitle className="text-white text-base">{selectedMemory}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-64 rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                      <code className="text-xs text-neutral-300 whitespace-pre-wrap font-mono">
                        {selectedMemoryContent}
                      </code>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}

              {claudeMd && (
                <Card className="bg-neutral-900 border-neutral-800">
                  <CardHeader>
                    <CardTitle className="text-white text-base">CLAUDE.md</CardTitle>
                    <CardDescription>Project instructions</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-48 rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                      <code className="text-xs text-neutral-300 whitespace-pre-wrap font-mono">
                        {claudeMd.slice(0, 600)}...
                      </code>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}

              {claudeConfig && (
                <Card className="bg-neutral-900 border-neutral-800">
                  <CardHeader>
                    <CardTitle className="text-white text-base">claude.json</CardTitle>
                    <CardDescription>Configuration</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-48 rounded-lg border border-neutral-800 bg-neutral-950 p-4">
                      <code className="text-xs text-neutral-300 whitespace-pre-wrap font-mono">
                        {claudeConfig.slice(0, 600)}...
                      </code>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
