import { describe, expect, it } from 'vitest';
import {
  SUGGESTIONS,
  WORK_FILTERS,
  agentAbilities,
  changeSummary,
  describeAction,
  isPlanTool,
  memberName,
  changeFactsOf,
  findingsOf,
  plainTaskText,
  readReport,
  verdictOf,
  workStatus,
} from './plain';
import { SCRIPTED_LABEL, providerLabel } from './status';

describe('workStatus', () => {
  it('speaks plainly and never shows a raw status', () => {
    expect(workStatus('waiting_approval').label).toBe('Needs your approval');
    expect(workStatus('failed').label).toBe("Couldn't finish");
    expect(workStatus('cancelled').label).toBe('Stopped');
    expect(workStatus('running', { paused: true }).label).toBe('Paused');
    expect(workStatus('completed', { paused: true }).label).toBe('Done');
    expect(workStatus('waiting_approval', { paused: true }).label).toBe('Needs your approval');
  });

  it('covers every status the API can return in a filter', () => {
    const covered = new Set(WORK_FILTERS.flatMap((f) => f.statuses));
    for (const status of ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted']) {
      expect(covered.has(status)).toBe(true);
    }
  });
});

describe('memberName', () => {
  it('uses the name, never the id when a name is known', () => {
    expect(memberName('orchestrator', [{ id: 'orchestrator', name: 'Coordinator' }])).toBe('Coordinator');
    expect(memberName('research', { research: { name: 'Researcher' } })).toBe('Researcher');
    expect(memberName('document-processing')).toBe('Document processing');
    expect(memberName(null)).toBe('Your AI team');
  });
});

describe('agentAbilities', () => {
  it('derives plain abilities from real tools and effective permissions', () => {
    const abilities = agentAbilities({
      tools: ['fs_read', 'fs_write', 'web_fetch', 'agent_list'],
      claude_code_tools: [],
      tools_detail: [
        { name: 'fs_read', available: true, risk: 'read', permission: 'allow', description: '' },
        { name: 'fs_write', available: true, risk: 'write', permission: 'ask', description: '' },
        { name: 'web_fetch', available: true, risk: 'external', permission: 'deny', description: '' },
        { name: 'agent_list', available: true, risk: 'read', permission: 'allow', description: '' },
      ],
    });
    expect(abilities.map((a) => a.kind)).toEqual(['read', 'web', 'team', 'files']);
    expect(abilities.find((a) => a.kind === 'files')).toMatchObject({ changesThings: true, asksFirst: true });
    expect(abilities.find((a) => a.kind === 'web')?.blocked).toBe(true);
    expect(changeSummary(abilities)).toBe('Can make changes, and always asks you first.');
  });

  it('treats Claude Code editing and commands as asking first', () => {
    const abilities = agentAbilities({ tools: [], claude_code_tools: ['Read', 'Edit', 'Bash'], tools_detail: [] });
    expect(abilities.filter((a) => a.asksFirst).map((a) => a.kind)).toEqual(['files', 'commands']);
  });

  it('says when a team member only reads', () => {
    const abilities = agentAbilities({ tools: ['fs_read', 'doc_extract_text'], claude_code_tools: [], tools_detail: [] });
    expect(changeSummary(abilities)).toBe('Only reads: it never changes anything.');
  });
});

describe('describeAction', () => {
  it('describes file changes, commands, web and email in plain words', () => {
    expect(describeAction('fs_write', { path: 'notes.md', content: '# Notes' })).toMatchObject({
      title: 'Create a file',
      phrase: 'create the file “notes.md” in the project folder',
      preview: '# Notes',
    });
    expect(describeAction('fs_write', { path: 'a.txt', content: 'x', mode: 'overwrite' }).phrase).toBe('replace the contents of the file “a.txt”');
    expect(describeAction('claude_code.Bash', { command: 'npm test' })).toMatchObject({ title: 'Run a command', preview: 'npm test' });
    expect(describeAction('web_fetch', { url: 'https://docs.example.org/x' }).effect).toContain('docs.example.org');
    expect(describeAction('email_send', { to: ['a@example.org'], subject: 'Hi', body: 'Hello' }).phrase).toBe(
      'send an email to a@example.org with the subject “Hi”',
    );
    expect(describeAction('mcp__github__create_issue', {}).phrase).toBe('use “create_issue” from your connection “github”');
  });

  it('describes the actions of ACP agents (Gemini CLI, Codex...) in the same words, naming the agent', () => {
    expect(describeAction('acp.gemini.execute', { command: 'npm test', title: 'Run the tests' })).toMatchObject({
      title: 'Run a command',
      phrase: 'run the command “npm test” (Gemini CLI)',
      preview: 'npm test',
      previewLabel: 'Command',
    });
    expect(describeAction('acp.codex.edit', { path: 'src/app.ts', diff: { path: 'src/app.ts', oldText: 'a', newText: 'b' } })).toMatchObject({
      title: 'Change a file',
      phrase: 'change the file “src/app.ts” (Codex)',
      preview: 'b',
    });
    expect(describeAction('acp.gemini.write_file', { path: 'notes.md', content: '# Notes' })).toMatchObject({
      title: 'Write a file',
      phrase: 'write the file “notes.md” (Gemini CLI)',
      preview: '# Notes',
    });
    expect(describeAction('acp.gemini.write_file', { diff: { path: 'new.md', oldText: null, newText: 'hi' } })).toMatchObject({
      title: 'Create a file',
      phrase: 'create the file “new.md” in the project folder (Gemini CLI)',
      preview: 'hi',
    });
    expect(describeAction('acp.copilot.delete', { path: 'old.txt' })).toMatchObject({ title: 'Delete a file', phrase: 'delete “old.txt” (GitHub Copilot)' });
    expect(describeAction('acp.goose.move', { path: 'a.txt' }).title).toBe('Move a file');
    const fetch = describeAction('acp.qwen.fetch', { title: 'Fetch https://docs.example.org/guide' });
    expect(fetch.phrase).toBe('read the web page https://docs.example.org/guide (Qwen Code)');
    expect(fetch.effect).toContain('docs.example.org');
    expect(describeAction('acp.opencode.read', { path: 'README.md' })).toMatchObject({ title: 'Read files', phrase: 'read the file “README.md” (OpenCode)' });
    expect(describeAction('acp.cursor.search', { title: 'grep TODO' })).toMatchObject({ title: 'Search the project', phrase: 'search the project (Cursor)', preview: 'grep TODO' });
    // Other kinds: the agent's own description says what it is.
    expect(describeAction('acp.mistral-vibe.other', { title: 'Update the plan' })).toMatchObject({ title: 'Update the plan', phrase: 'do “Update the plan” (Mistral Vibe)' });
    expect(describeAction('acp.gemini.switch_mode', {})).toMatchObject({ title: 'Change its working mode', phrase: 'change its working mode (Gemini CLI)' });
    // An agent the owner added is named from its id.
    expect(describeAction('acp.my-agent.execute', {}).phrase).toBe('run a command in the project folder (My agent)');
  });
});

describe('providerLabel', () => {
  it('names the agent a team member runs on', () => {
    expect(providerLabel('acp:gemini')).toBe('Gemini CLI');
    expect(providerLabel('acp:mistral-vibe')).toBe('Mistral Vibe');
    expect(providerLabel('acp:my_agent')).toBe('My agent');
    expect(providerLabel('claude-code')).toBe('Claude Code (subscription)');
    expect(providerLabel('default')).toBe('Platform default');
    expect(providerLabel('scripted')).toBe(SCRIPTED_LABEL);
  });
});

describe('plainTaskText', () => {
  it('drops the context the platform adds for agents', () => {
    const task = 'Write the notes.\n\n## Results handed off from prerequisite tasks\n<untrusted_data>...</untrusted_data>';
    expect(plainTaskText(task)).toBe('Write the notes.');
    expect(plainTaskText('Retry this\n\n## Previous attempt failed\nboom')).toBe('Retry this');
    expect(plainTaskText('Add the salary range\n\n## Earlier task this continues\nEarlier request: notes')).toBe('Add the salary range');
    expect(plainTaskText('Security review: Add an export\n\n## What to review\nThe change (task abc).')).toBe('Security review: Add an export');
  });
});

describe('a security review', () => {
  it('has a verdict only when the report gives a known one', () => {
    expect(verdictOf({ verdict: 'block' })).toBe('block');
    expect(verdictOf({ verdict: 'pass_with_warnings' })).toBe('pass_with_warnings');
    expect(verdictOf({ verdict: 'maybe' })).toBeNull();
    expect(verdictOf({ status: 'complete' })).toBeNull();
    expect(verdictOf('pass')).toBeNull();
  });

  it('lists its findings most severe first, with where each one is', () => {
    const findings = findingsOf({
      findings: [
        { severity: 'low', file: 'a.py', line: 0, issue: 'noisy log', fix: 'log less' },
        { severity: 'CRITICAL', file: 'b.py', line: 7, issue: 'open route', exploit: 'GET /x', fix: 'check the role' },
        { severity: 'odd', file: 'c.py', issue: 'unclear' },
        { severity: 'high', file: 'd.py', line: 2 },
        'not a finding',
      ],
    });
    expect(findings.map((f) => [f.severity, f.where, f.issue])).toEqual([
      ['critical', 'b.py:7', 'open route'],
      ['low', 'a.py', 'noisy log'],
      ['odd', 'c.py', 'unclear'],
    ]);
    expect(findingsOf({ findings: 'none' })).toEqual([]);
  });
});

describe('a code change', () => {
  it('gives the files it changed and the check it ran', () => {
    expect(changeFactsOf({ files_changed: ['a.py'], verification: { command: 'pytest', result: '4 passed', passed: true } })).toEqual({
      files: ['a.py'],
      check: { command: 'pytest', result: '4 passed', passed: true },
    });
    expect(changeFactsOf({ files_changed: ['a.py'] })).toEqual({ files: ['a.py'], check: null });
  });

  it('is nothing for a report that is not about code, or that changed nothing and checked nothing', () => {
    expect(changeFactsOf({ summary: 'Three constraints found' })).toBeNull();
    expect(changeFactsOf({ files_changed: [] })).toBeNull();
    expect(changeFactsOf('done')).toBeNull();
  });
});

describe('a plan to check', () => {
  const plan = {
    tasks: [
      { id: 'research', agent_id: 'research', title: 'Collect hiring constraints', task: 'List them.', depends_on: [], reason: 'facts' },
      { id: 'docs', agent_id: 'documentation', title: '', task: 'Write the notes\nfrom the findings.', depends_on: ['research'], reason: 'writes' },
    ],
    max_parallel: 2,
    stop_on_failure: true,
  };

  it('reads the Coordinator’s plan as numbered steps, with who does each one and what it waits for', () => {
    const action = describeAction('agent_run_plan', plan, { research: 'Researcher', documentation: { name: 'Technical Writer' } });
    expect(action.title).toBe('Check the plan');
    expect(action.phrase).toBe('start this plan (2 steps)');
    expect(action.plan).toEqual(['1. Researcher — Collect hiring constraints', '2. Technical Writer — Write the notes (after 1)']);
    // Without names, ids are humanized; the same words in the activity feed.
    expect(describeAction('mcp__pae__agent_run_plan', plan).plan?.[0]).toBe('1. Research — Collect hiring constraints');
    expect(isPlanTool('agent_delegate')).toBe(true);
    expect(isPlanTool('fs_write')).toBe(false);
  });

  it('reads a single hand-off as a one-step plan', () => {
    const action = describeAction('agent_delegate', { agent_id: 'research', task: 'Find the prices', title: 'Find prices' }, [{ id: 'research', name: 'Researcher' }]);
    expect(action.phrase).toBe('start this plan (1 step)');
    expect(action.plan).toEqual(['1. Researcher — Find prices']);
  });
});

describe('readReport', () => {
  it('reads the common report envelope', () => {
    const report = readReport({ status: 'partial', summary: '2 of 3 read', issues: ['one 404'], result: 'answer', findings: [] });
    expect(report).toMatchObject({ outcome: 'partial', summary: '2 of 3 read', answer: 'answer', issues: ['one 404'] });
    expect(report.details).toEqual({ findings: [] });
  });

  it('reads a document the Technical Writer returned as the answer', () => {
    const report = readReport({ status: 'complete', summary: 'Guide written', content: '# Guide', files_written: [], sources_read: [], issues: [] });
    expect(report.answer).toBe('# Guide');
    expect(report.details).toEqual({ files_written: [], sources_read: [] });
  });

  it('falls back to plain text', () => {
    expect(readReport(null, 'just text')).toMatchObject({ outcome: null, answer: 'just text', issues: [] });
  });
});

describe('SUGGESTIONS', () => {
  it('have plain titles, templates to fill in, and unique ids', () => {
    expect(new Set(SUGGESTIONS.map((s) => s.id)).size).toBe(SUGGESTIONS.length);
    for (const s of SUGGESTIONS) {
      expect(s.template).toMatch(/\[.+\]/);
      expect(s.title).not.toMatch(/agent|orchestrat|run\b/i);
    }
  });
});
