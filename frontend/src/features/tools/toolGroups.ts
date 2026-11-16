// "What your team can use": the platform's tools grouped in plain categories, each tool as a
// plain action, and the owner's rule (allow / ask / block) in plain words.

import type { Agent, Permission, ToolInfo } from '../../api/types';

export type ToolGroupId =
  | 'read'
  | 'documents'
  | 'data'
  | 'web'
  | 'files'
  | 'commands'
  | 'git'
  | 'services'
  | 'email'
  | 'team'
  | 'connections'
  | 'other';

export interface ToolGroupInfo {
  id: ToolGroupId;
  title: string;
  /** One sentence: what this lets the team do. */
  text: string;
  /** True when it can change something (files, other services, messages). */
  changes: boolean;
}

/** In the order shown: reading first, then what changes things. */
export const TOOL_GROUPS: ToolGroupInfo[] = [
  { id: 'read', title: 'Read files', text: 'List, open and search the project’s files.', changes: false },
  { id: 'documents', title: 'Read documents', text: 'Text and tables of PDF, Word, Excel and CSV.', changes: false },
  { id: 'data', title: 'Work with data', text: 'Analyse spreadsheets and databases, read only.', changes: false },
  { id: 'web', title: 'Read web pages', text: 'Open web pages outside this computer.', changes: false },
  { id: 'files', title: 'Change files', text: 'Create, change or delete files in the project folder.', changes: true },
  { id: 'commands', title: 'Run commands', text: 'Run commands, scripts and tests in the project.', changes: true },
  { id: 'git', title: 'Git history', text: 'See changes and save them in Git.', changes: true },
  { id: 'services', title: 'Other online services', text: 'Exchange data with online services (APIs, webhooks).', changes: true },
  { id: 'email', title: 'Email', text: 'Send emails; a sent email cannot be recalled.', changes: true },
  { id: 'team', title: 'Teamwork', text: 'Hand steps to colleagues and run plans.', changes: false },
  { id: 'connections', title: 'Your connections', text: 'Actions of the tools you connected below.', changes: true },
  { id: 'other', title: 'Other abilities', text: 'Abilities that fit no other group.', changes: true },
];

/** Each built-in tool as a plain action. Unknown tools fall back to their own description. */
const TOOL_TEXT: Record<string, string> = {
  fs_list: 'See which files are in the project folder',
  fs_read: 'Open and read a file',
  fs_search: 'Search for words inside files',
  fs_write: 'Create or change a file',
  fs_delete: 'Delete a file',
  doc_extract_text: 'Read the text of a document',
  doc_extract_tables: 'Read the tables of a document',
  data_profile: 'Summarise a data file (columns, gaps, values)',
  data_query: 'Compute results from a data file',
  data_validate: 'Check data against rules',
  sql_query: 'Read from a database file',
  web_fetch: 'Open a web page',
  http_request: 'Fetch data from, or send data to, an online service',
  webhook_send: 'Send a notification to a service (Slack, Teams…)',
  email_send: 'Send an email',
  shell_run: 'Run a command in the project folder',
  code_run_python: 'Run a Python script',
  git_status: 'See which files changed',
  git_diff: 'See the exact changes',
  git_log: 'See the history of saved changes',
  git_commit: 'Save changes in the Git history',
  agent_list: 'See who is in the team',
  agent_delegate: 'Hand a step to another team member',
  agent_run_plan: 'Run a plan of steps with several team members',
};

/** Claude Code's own tools (used by some team members through Claude Code), as plain actions. */
const CLAUDE_CODE_TEXT: Record<string, string> = {
  Read: 'Open and read a file, with Claude Code’s own tools',
  Glob: 'Find files by name, with Claude Code’s own tools',
  Grep: 'Search for words inside files, with Claude Code’s own tools',
  Edit: 'Edit a file, with Claude Code’s own tools',
  Write: 'Write a file, with Claude Code’s own tools',
  Bash: 'Run a command, with Claude Code’s own tools',
  WebFetch: 'Open a web page, with Claude Code’s own tools',
  WebSearch: 'Search the web, with Claude Code’s own tools',
};

/** Same table as the backend (runtime/claude_code.py BUILTIN_RISK / BUILTIN_DEFAULT). */
const CLAUDE_CODE_RISK: Record<string, ToolInfo['risk']> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Edit: 'write',
  Write: 'write',
  Bash: 'execute',
  WebFetch: 'external',
  WebSearch: 'external',
};

const CLAUDE_CODE_GROUP: Record<string, ToolGroupId> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Edit: 'files',
  Write: 'files',
  Bash: 'commands',
  WebFetch: 'web',
  WebSearch: 'web',
};

export const CLAUDE_CODE_PREFIX = 'claude_code.';

/**
 * Claude Code's own tools that at least one team member uses, as tool entries: the owner can set a
 * rule for them like for any other tool (permission name "claude_code.<Tool>").
 */
export function claudeCodeTools(agents: Pick<Agent, 'id' | 'claude_code_tools'>[], ownerRules: Record<string, Permission> = {}): ToolInfo[] {
  const users = new Map<string, string[]>();
  for (const agent of agents) {
    for (const tool of agent.claude_code_tools ?? []) {
      if (!CLAUDE_CODE_RISK[tool]) continue;
      users.set(tool, [...(users.get(tool) ?? []), agent.id]);
    }
  }
  return [...users.entries()].map(([tool, usedBy]) => {
    const risk = CLAUDE_CODE_RISK[tool]!;
    const name = `${CLAUDE_CODE_PREFIX}${tool}`;
    return {
      name,
      description: CLAUDE_CODE_TEXT[tool]!,
      category: 'claude-code',
      risk,
      default_permission: risk === 'read' ? 'allow' : 'ask',
      untrusted_output: false,
      timeout_s: 0,
      input_schema: {},
      source: 'claude-code',
      global_permission: ownerRules[name] ?? null,
      used_by: usedBy,
    };
  });
}

/** Tools whose "standard rule" has an exception for the websites you allowed. */
const ALLOWED_SITES_EXCEPTION = new Set(['web_fetch', 'http_request']);

export function isConnectionTool(tool: Pick<ToolInfo, 'name' | 'source'>): boolean {
  return tool.name.startsWith('mcp__') || (tool.source ?? '').startsWith('mcp');
}

/** "mcp__github__create_issue" → { server: "github", action: "create issue" }. */
export function connectionParts(name: string): { server: string; action: string } {
  const [, server = '', ...rest] = name.split('__');
  return { server, action: rest.join(' ').replace(/[_-]+/g, ' ') };
}

export function toolGroupOf(tool: Pick<ToolInfo, 'name' | 'category' | 'risk' | 'source'>): ToolGroupId {
  const name = tool.name;
  if (isConnectionTool(tool)) return 'connections';
  if (name.startsWith(CLAUDE_CODE_PREFIX)) return CLAUDE_CODE_GROUP[name.slice(CLAUDE_CODE_PREFIX.length)] ?? 'other';
  if (name.startsWith('agent_')) return 'team';
  if (name === 'fs_write' || name === 'fs_delete') return 'files';
  if (name === 'shell_run' || name === 'code_run_python') return 'commands';
  if (name.startsWith('git_')) return 'git';
  if (name.startsWith('doc_')) return 'documents';
  if (name.startsWith('data_') || name === 'sql_query') return 'data';
  if (name === 'web_fetch') return 'web';
  if (name === 'http_request' || name === 'webhook_send') return 'services';
  if (name === 'email_send') return 'email';
  if (name.startsWith('fs_')) return 'read';
  // Tools added later: their category, then their risk.
  switch (tool.category) {
    case 'files':
      return tool.risk === 'read' ? 'read' : 'files';
    case 'documents':
      return 'documents';
    case 'data':
      return 'data';
    case 'execution':
      return 'commands';
    case 'git':
      return 'git';
    case 'web':
      return 'services';
    case 'messaging':
      return 'email';
    case 'agents':
      return 'team';
    default:
      return 'other';
  }
}

/** What the tool does, in plain words. */
export function toolText(tool: Pick<ToolInfo, 'name' | 'description' | 'source'>): string {
  if (TOOL_TEXT[tool.name]) return TOOL_TEXT[tool.name]!;
  if (tool.name.startsWith(CLAUDE_CODE_PREFIX)) return CLAUDE_CODE_TEXT[tool.name.slice(CLAUDE_CODE_PREFIX.length)] ?? tool.name;
  if (isConnectionTool(tool)) {
    const { server, action } = connectionParts(tool.name);
    return action ? `${action.charAt(0).toUpperCase()}${action.slice(1)} (${server})` : tool.description;
  }
  return tool.description || tool.name;
}

/** Plain name of a tool for sentences ("used “Open a web page”"); the id when unknown. */
export function toolLabel(name: string): string {
  return TOOL_TEXT[name] ?? (name.startsWith('mcp__') ? toolText({ name, description: name, source: 'mcp' }) : name);
}

// ------------------------------------------------------------------ rules

export const RULE_LABEL: Record<Permission, string> = {
  allow: 'Allowed',
  ask: 'Asks you first',
  deny: 'Blocked',
};

/** The rule that applies to the whole team: yours if you set one, otherwise the standard one. */
export function currentRule(tool: Pick<ToolInfo, 'global_permission' | 'default_permission'>): { permission: Permission; yours: boolean } {
  return tool.global_permission
    ? { permission: tool.global_permission, yours: true }
    : { permission: tool.default_permission, yours: false };
}

/** The rule in plain words, with the allowed-websites exception where it applies. */
export function ruleText(tool: Pick<ToolInfo, 'name' | 'global_permission' | 'default_permission'>): string {
  const { permission, yours } = currentRule(tool);
  const base = RULE_LABEL[permission];
  if (!yours && permission === 'ask' && ALLOWED_SITES_EXCEPTION.has(tool.name)) return `${base}, except websites you allowed`;
  return base;
}

export type RuleChoice = '' | Permission;

/** The choices offered to the owner, with what each one means. '' removes the owner's rule. */
export const RULE_CHOICES: { value: RuleChoice; label: string; meaning: string }[] = [
  {
    value: '',
    label: 'Standard',
    meaning: 'The recommended rule for this action. A team member’s own advanced settings can make it stricter or looser.',
  },
  {
    value: 'ask',
    label: 'Always ask me first',
    meaning: 'Every team member must ask you before doing it, every time, even on websites you allowed.',
  },
  {
    value: 'allow',
    label: 'Allow without asking',
    meaning: 'Team members do it without asking you, unless you blocked it for a specific team member.',
  },
  {
    value: 'deny',
    label: 'Block',
    meaning: 'No team member can do it, whatever its own settings say.',
  },
];

export function choiceLabel(value: RuleChoice, tool: Pick<ToolInfo, 'name' | 'default_permission'>): string {
  if (value === '') return `Standard (${ruleText({ name: tool.name, global_permission: null, default_permission: tool.default_permission }).toLowerCase()})`;
  return RULE_CHOICES.find((c) => c.value === value)!.label;
}

// ------------------------------------------------------------------ grouping

export interface ToolGroup extends ToolGroupInfo {
  tools: ToolInfo[];
  /** Ids of the team members that have at least one of these tools. */
  usedBy: string[];
}

/** The tools grouped in the order of TOOL_GROUPS; empty groups are left out. */
export function groupTools(tools: ToolInfo[]): ToolGroup[] {
  const byGroup = new Map<ToolGroupId, ToolInfo[]>();
  for (const tool of tools) {
    const id = toolGroupOf(tool);
    byGroup.set(id, [...(byGroup.get(id) ?? []), tool]);
  }
  return TOOL_GROUPS.filter((g) => byGroup.has(g.id)).map((g) => {
    const members = byGroup.get(g.id)!;
    const usedBy = [...new Set(members.flatMap((t) => t.used_by ?? []))];
    return { ...g, tools: members, usedBy };
  });
}

/** One line for a group: the shared rule, or "Depends on the action" when its tools differ. */
export function groupRuleSummary(group: Pick<ToolGroup, 'tools'>): string {
  const texts = [...new Set(group.tools.map((t) => ruleText(t)))];
  return texts.length === 1 ? texts[0]! : 'Depends on the action';
}
