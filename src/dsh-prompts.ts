/**
 * Selected DeepSeek Harness built-in persona and tool-guidance text, adapted
 * for this Pi/Win7 runtime. Copyright (c) 2026 DeepSeek, MIT.
 * Exact origin and every compatibility substitution are recorded alongside
 * src/vendor/dsh-prompts/PROVENANCE.txt. These are agent presets, not a library
 * of user workflow/slash-command templates.
 */

export type DshPromptPreset = 'standard' | 'minimal';
const COMMIT = '639ed015397290b3745d163aafe02ffee4aa3f84';
const BASE = 'https://github.com/deepseek-ai/deepseek-harness/blob/' + COMMIT + '/';
const PRESET_PATH = 'packages/bundle/web-app/presets/';

// Verbatim excerpts from the pinned upstream files, kept separate from the
// substitutions below so the original text and adapted behavior are inspectable.
const ORIGINAL = {
  standard: 'You are a coding agent powered by the {{model}} model.',
  minimal: 'You are a helpful software engineer assistant.',
  cwd: 'Your working directory is {{cwd}}.',
  read: 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.',
  write: 'Read an existing file before overwriting it with write (the default fs-observation-policy requires it) and prefer edit for targeted changes.',
  edit: 'Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  grep: 'Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.',
  skill: "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
};

const presets = [
  { value: 'standard', name: '标准', description: 'DSH standard 原版身份与文件、Skill 工具指导，适配当前可用工具。', available: true, reason: '', source: BASE + PRESET_PATH + 'standard.patch.yml' },
  { value: 'minimal', name: '精简', description: 'DSH minimal 原版简短身份，沿用本版本的工具和权限规则。', available: true, reason: '', source: BASE + PRESET_PATH + 'minimal.patch.yml' },
  { value: 'ptc', name: 'PTC', description: 'DSH 程序化工具调用预设。', available: false, reason: '此预设需要 run_code 和程序化工具运行环境，本版本尚未迁移。', source: BASE + PRESET_PATH + 'ptc.patch.yml' },
  { value: 'cordis', name: 'Cordis', description: 'DSH 动态插件与预设构建环境。', available: false, reason: '此预设需要 Cordis 插件宿主与动态界面运行环境，本版本尚未迁移。', source: BASE + PRESET_PATH + 'cordis.patch.yml' },
];

export function getDshPromptPresets() { return presets.map(preset => ({ ...preset })); }
export function validDshPromptPreset(value: any): value is DshPromptPreset { return value === 'standard' || value === 'minimal'; }

export function renderDshPrompt(options: { preset?: DshPromptPreset; model: string; workspace: string; tools: Array<{ name: string } | string> }): string {
  const preset = options.preset || 'standard';
  if (!validDshPromptPreset(preset)) throw new Error('此 DSH 预设尚未适配，不能启用缺少运行环境的预设。');
  if (typeof options.model !== 'string' || typeof options.workspace !== 'string' || !Array.isArray(options.tools)) throw new Error('Invalid DSH prompt context.');
  // Upstream minimal declares complete:true: its persona is intentionally just
  // this sentence. Runtime permission/no-shell rules remain server-owned and
  // must still be appended by the caller for every preset and custom SYSTEM.md.
  if (preset === 'minimal') return ORIGINAL.minimal;
  const names = new Set(options.tools.map(tool => typeof tool === 'string' ? tool : tool.name));
  const sections: string[] = [
    // The original fixed identity says "powered by DeepSeek Harness". Retain
    // truthful runtime identity here; the following persona is upstream text.
    'You are an AI agent running in Pi Win7 Web.',
    ORIGINAL.standard.replace('{{model}}', () => options.model),
  ];
  if (names.has('read_file')) {
    sections.push(ORIGINAL.read.replace('the read tool — not shell commands like cat —', 'the read_file tool').replace('offset and limit', 'startLine and maxLines'));
  }
  if (names.has('write_file')) {
    let text = ORIGINAL.write.replace('with write (the default fs-observation-policy requires it)', 'with write_file');
    text = names.has('edit_file') ? text.replace('prefer edit for', 'prefer edit_file for') : text.replace(' and prefer edit for targeted changes', '');
    sections.push(text);
  }
  if (names.has('edit_file')) sections.push(ORIGINAL.edit.replace(' (the default fs-observation-policy requires it)', ''));
  if (names.has('search_files')) {
    let text = ORIGINAL.grep.replace('the grep tool — not shell grep or rg —', 'the search_files tool');
    text = names.has('read_file') ? text.replace('Use read on', 'Use read_file on') : text.replace(' Use read on a matched file when you need surrounding context.', '');
    sections.push(text);
  }
  if (names.has('read_skill')) sections.push(ORIGINAL.skill.replace('`skill`', '`read_skill`'));
  sections.push(ORIGINAL.cwd.replace('{{cwd}}', () => options.workspace));
  return sections.join('\n\n');
}
