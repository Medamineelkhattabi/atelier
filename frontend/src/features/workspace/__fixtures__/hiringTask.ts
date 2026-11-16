// Test fixtures: one real-shaped task, "Prepare hiring notes for the pipeline". The Coordinator
// splits it into two steps (Researcher, then Technical Writer, who asks to create a file).
// Event payloads follow backend/pae/runtime (manager.py, plans.py, approvals.py, gate.py, native.py);
// the graph follows backend/pae/runtime/graph.py. Used by tests only.

import type { Approval, ExecutionGraph, GraphEdge, GraphNode, RunDetailResponse, RunEvent, RunSummary } from '../../../api/types';
import { runDetail, usage } from '../../../test/graphFixtures';

export const AGENTS = {
  orchestrator: { name: 'Coordinator', responsibility: 'Plans the work and hands each step to the right team member.' },
  research: { name: 'Researcher', responsibility: 'Finds facts and their sources.' },
  documentation: { name: 'Technical Writer', responsibility: 'Writes documents.' },
};

export const REQUEST = 'Prepare hiring notes for the pipeline';

export const RESEARCH_OUTPUT = {
  status: 'complete',
  summary: 'Two constraints found',
  findings: [{ claim: 'Candidates are anonymised', evidence: 'brief', source_ids: ['s1'] }],
  sources: [{ id: 's1', location: 'project brief' }],
  open_questions: [],
  issues: [],
};

export const DOCS_OUTPUT = { status: 'complete', summary: 'notes written', files_written: ['hiring-notes.md'], sources_read: [], issues: [] };

export const FINAL_OUTPUT = {
  status: 'complete',
  summary: 'Notes written from the research.',
  steps: [
    { task_id: 'research', agent: 'research', task: 'constraints', status: 'completed' },
    { task_id: 'docs', agent: 'documentation', task: 'notes', status: 'completed' },
  ],
  result: 'hiring-notes.md written',
  validation: [],
  issues: [],
};

const PLAN_TASKS = [
  { id: 'research', agent_id: 'research', title: 'Collect hiring constraints', depends_on: [], after: [], reason: 'Sourced findings' },
  { id: 'docs', agent_id: 'documentation', title: 'Write the hiring notes', depends_on: ['research'], after: [], reason: 'Writes documents' },
];

const WRITE_ARGS = { path: 'hiring-notes.md', content: '# Hiring notes\n', mode: 'create' };

let clock = 0;
function ev(id: number, run_id: string, type: string, source: RunEvent['source'], data: Record<string, unknown>): RunEvent {
  clock += 1;
  const seconds = String(clock % 60).padStart(2, '0');
  return { id, run_id, root_run_id: 'root1', seq: id, ts: `2026-11-11T10:00:${seconds}+00:00`, type, source, data };
}

/** The events of the task, in order. `until` cuts the list (to model a task still in progress). */
export function hiringEvents(until: 'planned' | 'waiting' | 'done' = 'done'): RunEvent[] {
  clock = 0;
  const all: RunEvent[] = [
    ev(1, 'root1', 'run.queued', 'runtime', { kind: 'agent', agent_id: 'orchestrator', team_id: null, task: REQUEST, provider: 'scripted', model: 'scripted' }),
    ev(2, 'root1', 'run.started', 'runtime', { agent_id: 'orchestrator', kind: 'agent', provider: 'scripted', model: 'scripted', agent_version: '1.0.0', depth: 0, role: null }),
    ev(3, 'root1', 'step.started', 'runtime', { step: 1 }),
    ev(4, 'root1', 'model.request', 'runtime', { provider: 'scripted', model: 'scripted', attempt: 1 }),
    ev(5, 'root1', 'model.response', 'runtime', { provider: 'scripted', model: 'scripted', stop_reason: 'tool_use' }),
    ev(6, 'root1', 'agent.message', 'agent', { text: 'Research first, then documentation.' }),
    ev(7, 'root1', 'agent.tool_call', 'agent', { tool_call_id: 'c1', tool: 'agent_run_plan', input: { tasks: PLAN_TASKS } }),
    ev(8, 'root1', 'tool.permission', 'runtime', { tool_call_id: 'c1', tool: 'agent_run_plan', decision: 'allow', rule: 'default' }),
    ev(9, 'root1', 'tool.started', 'tool', { tool_call_id: 'c1', tool: 'agent_run_plan' }),
    ev(10, 'root1', 'plan.created', 'runtime', { plan_id: 'p1', created_by_run_id: 'root1', max_parallel: 3, tasks: PLAN_TASKS }),
    ev(11, 'root1', 'task.assigned', 'runtime', { plan_id: 'p1', task_id: 'research', agent_id: 'research', reason: 'Sourced findings' }),
    ev(12, 'root1', 'task.assigned', 'runtime', { plan_id: 'p1', task_id: 'docs', agent_id: 'documentation', reason: 'Writes documents' }),
    ev(13, 'root1', 'delegation.started', 'runtime', { child_run_id: 'run-r', agent_id: 'research', task: 'List the constraints in the project brief.', role: 'Collect hiring constraints' }),
    ev(14, 'run-r', 'run.queued', 'runtime', { kind: 'agent', agent_id: 'research', parent_run_id: 'root1', task: 'List the constraints', provider: 'scripted', model: 'scripted' }),
    ev(15, 'root1', 'task.started', 'runtime', { plan_id: 'p1', task_id: 'research', agent_id: 'research', child_run_id: 'run-r', attempt: 1 }),
    ev(16, 'run-r', 'run.started', 'runtime', { agent_id: 'research', kind: 'agent', provider: 'scripted', depth: 1, role: 'Collect hiring constraints' }),
    ev(17, 'run-r', 'agent.final', 'agent', { output: RESEARCH_OUTPUT }),
    ev(18, 'run-r', 'run.completed', 'runtime', { output_preview: JSON.stringify(RESEARCH_OUTPUT), steps: 1, tool_calls: 0, duration_s: 0.4 }),
    ev(19, 'root1', 'delegation.completed', 'runtime', { child_run_id: 'run-r', agent_id: 'research', status: 'completed', output_preview: '{...}' }),
    ev(20, 'root1', 'task.completed', 'runtime', { plan_id: 'p1', task_id: 'research', child_run_id: 'run-r', output_preview: JSON.stringify(RESEARCH_OUTPUT), duration_s: 0.4 }),
    ev(21, 'root1', 'handoff', 'runtime', { plan_id: 'p1', from_task_id: 'research', to_task_id: 'docs', from_run_id: 'run-r', to_agent_id: 'documentation', summary: '[complete] Two constraints found' }),
    ev(22, 'root1', 'delegation.started', 'runtime', { child_run_id: 'run-d', agent_id: 'documentation', task: 'Write hiring-notes.md', role: 'Write the hiring notes' }),
    ev(23, 'run-d', 'run.queued', 'runtime', { kind: 'agent', agent_id: 'documentation', parent_run_id: 'root1', task: 'Write hiring-notes.md', provider: 'scripted' }),
    ev(24, 'root1', 'task.started', 'runtime', { plan_id: 'p1', task_id: 'docs', agent_id: 'documentation', child_run_id: 'run-d', attempt: 1 }),
    ev(25, 'run-d', 'run.started', 'runtime', { agent_id: 'documentation', kind: 'agent', provider: 'scripted', depth: 1, role: 'Write the hiring notes' }),
    ev(26, 'run-d', 'agent.tool_call', 'agent', { tool_call_id: 'w1', tool: 'fs_write', input: { path: 'hiring-notes.md', content: '# Hiring notes\n' } }),
    ev(27, 'run-d', 'tool.permission', 'runtime', { tool_call_id: 'w1', tool: 'fs_write', decision: 'ask', rule: 'default' }),
    ev(28, 'run-d', 'approval.requested', 'runtime', { approval_id: 'appr-1', tool: 'fs_write', tool_call_id: 'w1', args: WRITE_ARGS, risk: 'write', reason: null, timeout_s: 900 }),
    ev(29, 'run-d', 'run.status', 'runtime', { status: 'waiting_approval' }),
    ev(30, 'run-d', 'approval.decided', 'user', { approval_id: 'appr-1', decision: 'approved', note: null, tool: 'fs_write' }),
    ev(31, 'run-d', 'run.status', 'runtime', { status: 'running' }),
    ev(32, 'run-d', 'tool.started', 'tool', { tool_call_id: 'w1', tool: 'fs_write' }),
    ev(33, 'run-d', 'tool.completed', 'tool', { tool_call_id: 'w1', tool: 'fs_write', duration_ms: 3, output: 'Created hiring-notes.md (15 characters)', data: null }),
    ev(34, 'run-d', 'agent.final', 'agent', { output: DOCS_OUTPUT }),
    ev(35, 'run-d', 'run.completed', 'runtime', { output_preview: JSON.stringify(DOCS_OUTPUT), steps: 2, tool_calls: 1, duration_s: 1.2 }),
    ev(36, 'root1', 'delegation.completed', 'runtime', { child_run_id: 'run-d', agent_id: 'documentation', status: 'completed', output_preview: '{...}' }),
    ev(37, 'root1', 'task.completed', 'runtime', { plan_id: 'p1', task_id: 'docs', child_run_id: 'run-d', output_preview: JSON.stringify(DOCS_OUTPUT), duration_s: 1.2 }),
    ev(38, 'root1', 'plan.completed', 'runtime', { plan_id: 'p1', completed: 2, failed: 0, skipped: 0 }),
    ev(39, 'root1', 'tool.completed', 'tool', { tool_call_id: 'c1', tool: 'agent_run_plan', duration_ms: 1700, output: '{...}' }),
    ev(40, 'root1', 'agent.final', 'agent', { output: FINAL_OUTPUT }),
    ev(41, 'root1', 'run.completed', 'runtime', { output_preview: JSON.stringify(FINAL_OUTPUT), steps: 2, tool_calls: 1, duration_s: 2.1 }),
  ];
  const last = until === 'planned' ? 12 : until === 'waiting' ? 29 : 41;
  return all.filter((e) => e.id <= last);
}

/** The graph of the task: while the writer waits for the approval, or once everything is done. */
export function hiringGraph(state: 'waiting' | 'done' = 'waiting'): ExecutionGraph {
  const done = state === 'done';
  const nodes: GraphNode[] = [
    {
      id: 'run:root1',
      kind: 'root',
      run_id: 'root1',
      agent_id: 'orchestrator',
      team_id: null,
      label: 'Coordinator',
      status: done ? 'completed' : 'running',
      started_at: '2026-11-11T10:00:02+00:00',
      finished_at: done ? '2026-11-11T10:00:41+00:00' : null,
      usage: usage({ duration_s: done ? 39 : null }),
      error: null,
    },
    {
      id: 'task:p1:research',
      kind: 'task',
      plan_id: 'p1',
      task_id: 'research',
      parent_id: 'run:root1',
      agent_id: 'research',
      title: 'Collect hiring constraints',
      reason: 'Sourced findings',
      depends_on: [],
      status: 'completed',
      attempts: 1,
      run_ids: ['run-r'],
      current_run_id: 'run-r',
      input_summary: 'List the constraints in the project brief.',
      output_preview: JSON.stringify(RESEARCH_OUTPUT),
      error: null,
      started_at: '2026-11-11T10:00:15+00:00',
      finished_at: '2026-11-11T10:00:20+00:00',
      usage: usage({ duration_s: 5, steps: 1 }),
      tools_used: {},
      pending_approvals: 0,
    },
    {
      id: 'task:p1:docs',
      kind: 'task',
      plan_id: 'p1',
      task_id: 'docs',
      parent_id: 'run:root1',
      agent_id: 'documentation',
      title: 'Write the hiring notes',
      reason: 'Writes documents',
      depends_on: ['task:p1:research'],
      status: done ? 'completed' : 'waiting_approval',
      attempts: 1,
      run_ids: ['run-d'],
      current_run_id: 'run-d',
      input_summary: 'Write hiring-notes.md from the research findings.',
      output_preview: done ? JSON.stringify(DOCS_OUTPUT) : null,
      error: null,
      started_at: '2026-11-11T10:00:24+00:00',
      finished_at: done ? '2026-11-11T10:00:37+00:00' : null,
      usage: usage({ duration_s: done ? 13 : null, steps: 2, tool_calls: done ? 1 : 0 }),
      tools_used: done ? { fs_write: 1 } : {},
      pending_approvals: done ? 0 : 1,
    },
    {
      id: 'approval:appr-1',
      kind: 'approval',
      approval_id: 'appr-1',
      run_id: 'run-d',
      attached_to: 'task:p1:docs',
      tool: 'fs_write',
      risk: 'write',
      status: done ? 'approved' : 'pending',
      reason: null,
      args: WRITE_ARGS,
    },
    { id: 'result:root1', kind: 'result', status: done ? 'completed' : 'pending', output_preview: done ? JSON.stringify(FINAL_OUTPUT) : null },
  ];
  const edges: GraphEdge[] = [
    { id: 'delegates:run:root1->task:p1:research', source: 'run:root1', target: 'task:p1:research', kind: 'delegates', active: false, label: 'assigned' },
    { id: 'delegates:run:root1->task:p1:docs', source: 'run:root1', target: 'task:p1:docs', kind: 'delegates', active: !done, label: 'assigned' },
    { id: 'depends_on:task:p1:research->task:p1:docs', source: 'task:p1:research', target: 'task:p1:docs', kind: 'depends_on', active: !done },
    { id: 'handoff:task:p1:research->task:p1:docs', source: 'task:p1:research', target: 'task:p1:docs', kind: 'handoff', active: !done, label: '[complete] Two constraints found' },
    { id: 'approval:task:p1:docs->approval:appr-1', source: 'task:p1:docs', target: 'approval:appr-1', kind: 'approval', active: !done, label: 'fs_write' },
    { id: 'consolidates:task:p1:docs->result:root1', source: 'task:p1:docs', target: 'result:root1', kind: 'consolidates', active: false },
  ];
  return {
    root_run_id: 'root1',
    project_id: 'hiring',
    status: done ? 'completed' : 'running',
    paused: false,
    title: REQUEST,
    last_event_id: done ? 41 : 29,
    agents: AGENTS,
    nodes,
    edges,
  };
}

const summary = (overrides: Partial<RunSummary>): RunSummary => {
  const { tree } = runDetail();
  return { ...tree[0]!, ...overrides };
};

export const APPROVAL: Approval = {
  id: 'appr-1',
  run_id: 'run-d',
  root_run_id: 'root1',
  agent_id: 'documentation',
  tool: 'fs_write',
  tool_call_id: 'w1',
  args: WRITE_ARGS,
  risk: 'write',
  reason: null,
  status: 'pending',
  note: null,
  created_at: '2026-11-11T10:00:28+00:00',
  decided_at: null,
  expires_at: '2099-11-11T10:15:28+00:00',
  run_task: 'Write hiring-notes.md',
  project_id: 'hiring',
};

/** GET /api/runs/root1 for the task. */
export function hiringRun(state: 'waiting' | 'done' = 'waiting'): RunDetailResponse {
  const done = state === 'done';
  const base = runDetail({
    id: 'root1',
    agent_id: 'orchestrator',
    task: REQUEST,
    status: done ? 'completed' : 'running',
    provider: 'scripted',
    scripted: true,
    project_id: 'hiring',
    output: done ? FINAL_OUTPUT : null,
    output_text: null,
    finished_at: done ? '2026-11-11T10:00:41+00:00' : null,
  });
  return {
    ...base,
    tree: [
      base.tree[0]!,
      summary({ id: 'run-r', agent_id: 'research', parent_run_id: 'root1', status: 'completed', task: 'List the constraints in the project brief.' }),
      summary({ id: 'run-d', agent_id: 'documentation', parent_run_id: 'root1', status: done ? 'completed' : 'waiting_approval', task: 'Write hiring-notes.md' }),
    ],
    approvals: [done ? { ...APPROVAL, status: 'approved', decided_at: '2026-11-11T10:00:30+00:00' } : APPROVAL],
  };
}
