import { describe, expect, it } from 'vitest';
import { agentFor, toolInfo } from '../team/fixtures';
import {
  choiceLabel,
  claudeCodeTools,
  currentRule,
  groupRuleSummary,
  groupTools,
  ruleText,
  toolGroupOf,
  toolLabel,
  toolText,
} from './toolGroups';

const BUILTIN = [
  'agent_delegate',
  'fs_write',
  'git_commit',
  'fs_read',
  'web_fetch',
  'http_request',
  'shell_run',
  'doc_extract_text',
  'data_query',
  'email_send',
  'git_status',
  'fs_list',
].map((name) => toolInfo(name, { used_by: name.startsWith('fs_') ? ['research'] : [] }));

describe('tool groups', () => {
  it('puts every tool in a plain category, in the order reading → changing → teamwork', () => {
    const groups = groupTools(BUILTIN);
    expect(groups.map((g) => g.title)).toEqual([
      'Read files',
      'Read documents',
      'Work with data',
      'Read web pages',
      'Change files',
      'Run commands',
      'Git history',
      'Other online services',
      'Email',
      'Teamwork',
    ]);
    const read = groups.find((g) => g.id === 'read')!;
    expect(read.tools.map((t) => t.name)).toEqual(['fs_read', 'fs_list']);
    expect(read.usedBy).toEqual(['research']);
    expect(read.changes).toBe(false);
    expect(groups.find((g) => g.id === 'git')!.tools.map((t) => t.name)).toEqual(['git_commit', 'git_status']);
    expect(groups.find((g) => g.id === 'files')!.changes).toBe(true);
  });

  it('places connection tools, Claude Code tools and unknown tools', () => {
    expect(toolGroupOf(toolInfo('mcp__github__create_issue', { source: 'mcp:github', category: 'mcp:github' }))).toBe('connections');
    expect(toolGroupOf(toolInfo('claude_code.Edit', { source: 'claude-code' }))).toBe('files');
    expect(toolGroupOf(toolInfo('claude_code.Bash', { source: 'claude-code' }))).toBe('commands');
    expect(toolGroupOf(toolInfo('pdf_sign', { category: 'documents' }))).toBe('documents');
    expect(toolGroupOf(toolInfo('mystery', { category: 'misc' }))).toBe('other');
  });

  it('describes each tool as a plain action', () => {
    expect(toolText(toolInfo('fs_write'))).toBe('Create or change a file');
    expect(toolText(toolInfo('mcp__github__create_issue', { source: 'mcp:github' }))).toBe('Create issue (github)');
    expect(toolText(toolInfo('new_tool', { description: 'Does something new.' }))).toBe('Does something new.');
    expect(toolLabel('web_fetch')).toBe('Open a web page');
    expect(toolLabel('unknown_tool')).toBe('unknown_tool');
  });

  it('turns Claude Code tools used by team members into rules the owner can change', () => {
    const team = [
      agentFor('software-engineering', 'Software Engineer', { claude_code_tools: ['Read', 'Edit', 'TodoWrite'] }),
      agentFor('debugging', 'Debugger', { claude_code_tools: ['Edit'] }),
    ];
    const tools = claudeCodeTools(team, { 'claude_code.Edit': 'deny' });
    expect(tools.map((t) => [t.name, t.default_permission, t.global_permission, t.used_by])).toEqual([
      ['claude_code.Read', 'allow', null, ['software-engineering']],
      ['claude_code.Edit', 'ask', 'deny', ['software-engineering', 'debugging']],
    ]);
    expect(toolText(tools[1]!)).toBe('Edit a file, with Claude Code’s own tools');
  });
});

describe('rules in plain words', () => {
  it('shows the owner’s rule when there is one, otherwise the standard rule', () => {
    expect(currentRule(toolInfo('fs_write'))).toEqual({ permission: 'ask', yours: false });
    expect(currentRule(toolInfo('fs_write', { global_permission: 'allow' }))).toEqual({ permission: 'allow', yours: true });
    expect(ruleText(toolInfo('fs_read'))).toBe('Allowed');
    expect(ruleText(toolInfo('fs_write', { global_permission: 'deny' }))).toBe('Blocked');
    // Web pages: allowed websites are opened without asking, unless the owner requires approval.
    expect(ruleText(toolInfo('web_fetch'))).toBe('Asks you first, except websites you allowed');
    expect(ruleText(toolInfo('web_fetch', { global_permission: 'ask' }))).toBe('Asks you first');
  });

  it('labels the standard choice with what it means for this action', () => {
    expect(choiceLabel('', toolInfo('fs_write'))).toBe('Standard (asks you first)');
    expect(choiceLabel('', toolInfo('fs_read'))).toBe('Standard (allowed)');
    expect(choiceLabel('deny', toolInfo('fs_read'))).toBe('Block');
  });

  it('summarises a group with one rule, or says it depends', () => {
    expect(groupRuleSummary({ tools: [toolInfo('fs_read'), toolInfo('fs_list')] })).toBe('Allowed');
    expect(groupRuleSummary({ tools: [toolInfo('git_status'), toolInfo('git_commit')] })).toBe('Depends on the action');
  });
});
