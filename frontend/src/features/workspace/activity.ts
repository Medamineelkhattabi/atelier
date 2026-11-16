// The plain-language activity feed of a task: one sentence per meaningful event of its run tree,
// in the order the platform recorded them. Built only from real events; an event type that is not
// listed here is not shown, and nothing is shown for something that did not happen.
// Tool-level actions (read a file, ran a command...) are marked `everyAction`: shown on demand.

import type { RunEvent } from '../../api/types';
import { acpFacts, acpTool, describeAction, memberName, type AcpTool } from '../../lib/plain';
import { cleanSummary, plainError, type Names } from './steps';

export type ActivityKind =
  | 'start'
  | 'plan'
  | 'step-start'
  | 'handoff'
  | 'step-done'
  | 'step-failed'
  | 'step-skipped'
  | 'retry'
  | 'approval'
  | 'approved'
  | 'declined'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'limit'
  | 'action'
  | 'action-failed'
  | 'message';

export type Actor = { agentId: string; name: string } | 'you' | null;

export interface ActivityItem {
  /** The id of the event it comes from. */
  id: number;
  ts: string;
  kind: ActivityKind;
  /** Who did it: a team member, the owner ('you'), or nobody in particular (null). */
  actor: Actor;
  text: string;
  /** An optional second line: a summary, a reason, the steps of a plan. */
  detail?: string;
  /** A tool-level action or message, shown only with "Show every action". */
  everyAction: boolean;
}

export interface ActivityContext {
  rootRunId: string;
  names?: Names;
  /** Who runs the root: a team member id, or null for a team. */
  rootAgentId?: string | null;
  /** Run id -> team member id, from the run tree and the graph (events complete it). */
  runAgents?: Record<string, string | null | undefined>;
  /** Plan task titles and members by "plan:task", from the graph (events complete it). */
  tasks?: Record<string, { title: string; agentId: string }>;
}

const TEAM_TOOLS = new Set(['agent_run_plan', 'agent_delegate', 'agent_list', 'final_answer', 'TodoWrite', 'claude_code.TodoWrite']);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const short = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);
const quoted = (text: string) => `“${text}”`;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** An action of an ACP agent (Gemini CLI, Codex...), naming the agent: "ran the command “npm test” (Gemini CLI)". */
function acpWords(acp: AcpTool, args: unknown): { done: string; todo: string } {
  const f = acpFacts(args);
  const by = ` (${acp.engine})`;
  const file = f.path ? `the file ${quoted(f.path)}` : 'a file';
  const pair = (done: string, todo: string) => ({ done: `${done}${by}`, todo: `${todo}${by}` });
  const title = quoted(short(f.title, 80));
  switch (acp.kind) {
    case 'read':
      return pair(`read ${f.path ? file : 'files'}`, `read ${f.path ? file : 'files'}`);
    case 'search':
      return pair('searched the project', 'search the project');
    case 'edit':
      return pair(`changed ${file}`, `change ${file}`);
    case 'write_file':
      if (f.change === 'create') return pair(`created ${file}`, `create ${file}`);
      if (f.change === 'change') return pair(`changed ${file}`, `change ${file}`);
      return pair(`wrote ${file}`, `write ${file}`);
    case 'delete':
      return pair(`deleted ${f.path ? quoted(f.path) : 'a file'}`, `delete ${f.path ? quoted(f.path) : 'a file'}`);
    case 'move':
      return pair(`moved ${file}`, `move ${file}`);
    case 'execute': {
      const command = quoted(short(f.command.replace(/\s+/g, ' ').trim(), 80));
      return f.command ? pair(`ran the command ${command}`, `run the command ${command}`) : pair('ran a command', 'run a command');
    }
    case 'fetch':
      return f.url ? pair(`read a web page on ${hostOf(f.url)}`, `read a web page on ${hostOf(f.url)}`) : pair('read a web page', 'read a web page');
    case 'think':
      return pair('thought it through', 'think it through');
    case 'switch_mode':
      return f.title ? pair(`did ${title}`, `do ${title}`) : pair('changed its working mode', 'change its working mode');
    default:
      return f.title ? pair(`did ${title}`, `do ${title}`) : pair('used one of its tools', 'use one of its tools');
  }
}

/** A tool call in plain words: [what was done, what it means to do]. */
export function actionWords(tool: string, args: unknown): { done: string; todo: string } | null {
  const name = tool.replace(/^claude_code\./, '').replace(/^mcp__pae__/, '');
  if (TEAM_TOOLS.has(name)) return null;
  const acp = acpTool(name);
  if (acp) return acpWords(acp, args);
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const path = str(a.path ?? a.file_path ?? a.notebook_path);
  const file = path ? `the file ${quoted(path)}` : 'a file';
  const folder = path && path !== '.' ? `the folder ${quoted(path)}` : 'the project folder';
  const same = (text: string) => ({ done: text, todo: text });
  switch (name) {
    case 'fs_read':
    case 'Read':
      return same(`read ${file}`);
    case 'fs_list':
    case 'LS':
    case 'Glob':
      return { done: `looked at the files in ${folder}`, todo: `look at the files in ${folder}` };
    case 'fs_search':
    case 'Grep':
      return { done: `searched the files for ${quoted(short(str(a.pattern), 60))}`, todo: `search the files for ${quoted(short(str(a.pattern), 60))}` };
    case 'fs_write': {
      const mode = str(a.mode) || 'create';
      if (mode === 'overwrite') return { done: `replaced the contents of ${file}`, todo: `replace the contents of ${file}` };
      if (mode === 'append') return { done: `added text to ${file}`, todo: `add text to ${file}` };
      return { done: `created ${file}`, todo: `create ${file}` };
    }
    case 'Write':
      return { done: `wrote ${file}`, todo: `write ${file}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { done: `edited ${file}`, todo: `edit ${file}` };
    case 'fs_delete':
      return { done: `deleted ${quoted(path)}`, todo: `delete ${quoted(path)}` };
    case 'shell_run':
    case 'Bash':
      return str(a.command)
        ? { done: `ran the command ${quoted(short(str(a.command), 80))}`, todo: `run the command ${quoted(short(str(a.command), 80))}` }
        : { done: 'ran a command', todo: 'run a command' };
    case 'code_run_python':
      return { done: 'ran a Python script', todo: 'run a Python script' };
    case 'git_status':
      return { done: 'checked which files changed', todo: 'check which files changed' };
    case 'git_diff':
      return { done: 'looked at the changes', todo: 'look at the changes' };
    case 'git_log':
      return same('read the project history');
    case 'git_commit':
      return { done: 'saved the changes in Git', todo: 'save the changes in Git' };
    case 'web_fetch':
    case 'WebFetch':
      return same(`read a web page on ${hostOf(str(a.url))}`);
    case 'WebSearch':
      return { done: `searched the web for ${quoted(short(str(a.query), 60))}`, todo: `search the web for ${quoted(short(str(a.query), 60))}` };
    case 'http_request':
      return (str(a.method) || 'GET').toUpperCase() === 'GET'
        ? { done: `fetched data from ${hostOf(str(a.url))}`, todo: `fetch data from ${hostOf(str(a.url))}` }
        : { done: `sent data to ${hostOf(str(a.url))}`, todo: `send data to ${hostOf(str(a.url))}` };
    case 'webhook_send':
      return { done: `sent a notification to ${hostOf(str(a.url))}`, todo: `send a notification to ${hostOf(str(a.url))}` };
    case 'email_send': {
      const to = Array.isArray(a.to) ? a.to.map(str).join(', ') : str(a.to);
      return { done: `sent an email to ${to}`, todo: `send an email to ${to}` };
    }
    case 'doc_extract_text':
      return same(`read the document ${quoted(path)}`);
    case 'doc_extract_tables':
      return { done: `took the tables out of ${quoted(path)}`, todo: `take the tables out of ${quoted(path)}` };
    case 'data_profile':
      return { done: `looked at the data in ${quoted(path)}`, todo: `look at the data in ${quoted(path)}` };
    case 'data_query':
      return { done: `looked up figures in ${quoted(path)}`, todo: `look up figures in ${quoted(path)}` };
    case 'data_validate':
      return { done: `checked the data in ${quoted(path)}`, todo: `check the data in ${quoted(path)}` };
    case 'sql_query':
      return { done: `looked up data in the database ${quoted(str(a.database))}`, todo: `look up data in the database ${quoted(str(a.database))}` };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        const what = `“${rest.join('__')}” from your connection “${server}”`;
        return { done: `used ${what}`, todo: `use ${what}` };
      }
      return { done: `used the tool “${name}”`, todo: `use the tool “${name}”` };
  }
}

/** Turns the events of one task (its whole run tree) into plain activity items, oldest first. */
export function buildActivity(events: RunEvent[], context: ActivityContext): ActivityItem[] {
  const names = context.names ?? {};
  const runAgents = new Map<string, string>();
  for (const [run, agent] of Object.entries(context.runAgents ?? {})) if (agent) runAgents.set(run, agent);
  if (context.rootAgentId) runAgents.set(context.rootRunId, context.rootAgentId);
  const tasks = new Map(Object.entries(context.tasks ?? {}));
  const approvals = new Map<string, { agentId: string | null; todo: string }>();
  const calls = new Map<string, { tool: string; input: unknown }>();

  // Tool calls that reached an outcome (a started call without one is still in progress).
  const finished = new Set<string>();
  for (const event of events) {
    const id = str(event.data.tool_call_id);
    if (id && (event.type === 'tool.completed' || event.type === 'tool.failed')) finished.add(`${event.run_id}:${id}`);
  }

  const member = (agentId: string | null | undefined): Actor => (agentId ? { agentId, name: memberName(agentId, names) } : null);
  const nameOf = (agentId: string | null | undefined, fallback = 'A team member') => (agentId ? memberName(agentId, names) : fallback);
  const agentOfRun = (runId: string) => runAgents.get(runId) ?? null;
  const taskOf = (data: Record<string, unknown>, key = 'task_id') => tasks.get(`${str(data.plan_id)}:${str(data[key])}`);
  const isRoot = (event: RunEvent) => event.run_id === context.rootRunId;

  const items: ActivityItem[] = [];
  const add = (event: RunEvent, kind: ActivityKind, actor: Actor, text: string, detail?: string, everyAction = false) => {
    items.push({ id: event.id, ts: event.ts, kind, actor, text, ...(detail ? { detail } : {}), everyAction });
  };

  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      // ------------------------------------------------------------ who runs what
      case 'run.queued':
      case 'delegation.started':
        if (event.type === 'run.queued' && str(data.agent_id)) runAgents.set(event.run_id, str(data.agent_id));
        if (event.type === 'delegation.started' && str(data.child_run_id) && str(data.agent_id)) runAgents.set(str(data.child_run_id), str(data.agent_id));
        break;
      case 'run.started':
      case 'run.resumed':
        if (str(data.agent_id)) runAgents.set(event.run_id, str(data.agent_id));
        if (!isRoot(event)) break;
        if (event.type === 'run.resumed') add(event, 'resume', null, 'The work continued from where it stopped');
        else if (context.rootAgentId) add(event, 'start', member(context.rootAgentId), `${nameOf(context.rootAgentId)} started working on your request`);
        else add(event, 'start', null, 'Your team started working on your request');
        break;

      // ------------------------------------------------------------ plans and steps
      case 'plan.created': {
        const list = Array.isArray(data.tasks) ? (data.tasks as Record<string, unknown>[]) : [];
        for (const task of list) tasks.set(`${str(data.plan_id)}:${str(task.id)}`, { title: str(task.title), agentId: str(task.agent_id) });
        if (list.length === 0) break;
        const plannerRun = str(data.created_by_run_id) || event.run_id;
        const planner = plannerRun === context.rootRunId ? (context.rootAgentId ?? null) : agentOfRun(plannerRun);
        const detail = list.map((t) => `${str(t.title)} (${nameOf(str(t.agent_id))})`).join(' · ');
        if (list.length === 1) {
          const who = nameOf(str(list[0]!.agent_id));
          if (planner) add(event, 'plan', member(planner), `${nameOf(planner)} handed a step to ${who}`, str(list[0]!.title));
          else add(event, 'plan', null, `The work was handed to ${who}`, str(list[0]!.title));
        } else if (planner && plannerRun !== context.rootRunId) {
          add(event, 'plan', member(planner), `${nameOf(planner)} split their step into ${list.length} steps`, detail);
        } else if (planner) {
          add(event, 'plan', member(planner), `${nameOf(planner)} split the work into ${list.length} steps`, detail);
        } else {
          add(event, 'plan', null, `Your team’s work was split into ${list.length} steps`, detail);
        }
        break;
      }
      case 'task.started': {
        const task = taskOf(data);
        const agent = str(data.agent_id) || task?.agentId || null;
        if (str(data.child_run_id) && agent) runAgents.set(str(data.child_run_id), agent);
        const title = task?.title ? quoted(task.title) : 'a step';
        const attempt = typeof data.attempt === 'number' ? data.attempt : 1;
        add(event, 'step-start', member(agent), attempt > 1 ? `${nameOf(agent)} started ${title} again (attempt ${attempt})` : `${nameOf(agent)} started ${title}`);
        break;
      }
      case 'task.retry': {
        const task = taskOf(data);
        add(event, 'retry', member(task?.agentId), `${task?.title ? quoted(task.title) : 'A step'} did not work; ${nameOf(task?.agentId)} is trying again`, plainError(str(data.previous_error)) ?? undefined);
        break;
      }
      case 'handoff': {
        const from = taskOf(data, 'from_task_id');
        const to = taskOf(data, 'to_task_id');
        const toAgent = str(data.to_agent_id) || to?.agentId || null;
        const summary = cleanSummary(str(data.summary));
        if (from?.agentId && from.agentId === toAgent) {
          add(event, 'handoff', member(from.agentId), `${nameOf(from.agentId)} passed the results of ${quoted(from.title)} on to ${quoted(to?.title ?? 'the next step')}`, summary || undefined);
        } else {
          add(event, 'handoff', member(from?.agentId), `${nameOf(from?.agentId)} passed its results to ${nameOf(toAgent)}`, summary || undefined);
        }
        break;
      }
      case 'task.completed': {
        const task = taskOf(data);
        const title = task?.title ? quoted(task.title) : 'a step';
        if (data.resumed) add(event, 'step-done', member(task?.agentId), `${nameOf(task?.agentId)} had already finished ${title}; that result is used again`);
        else add(event, 'step-done', member(task?.agentId), `${nameOf(task?.agentId)} finished ${title}`);
        break;
      }
      case 'task.failed': {
        const task = taskOf(data);
        const title = task?.title ? quoted(task.title) : 'a step';
        if (data.status === 'cancelled') add(event, 'stop', member(task?.agentId), `${title.replace(/^a/, 'A')} was stopped before it finished`);
        else add(event, 'step-failed', member(task?.agentId), `${nameOf(task?.agentId)} could not finish ${title}`, plainError(str(data.error)) ?? undefined);
        break;
      }
      case 'task.skipped': {
        const task = taskOf(data);
        const titles = new Map([...tasks].filter(([key]) => key.startsWith(`${str(data.plan_id)}:`)).map(([key, t]) => [key.slice(str(data.plan_id).length + 1), t.title]));
        add(event, 'step-skipped', member(task?.agentId), `${task?.title ? quoted(task.title) : 'A step'} was skipped`, plainError(str(data.reason), { titles, names }) ?? undefined);
        break;
      }

      // ------------------------------------------------------------ approvals
      case 'approval.requested': {
        const agent = agentOfRun(event.run_id);
        const action = describeAction(str(data.tool), data.args);
        approvals.set(str(data.approval_id), { agentId: agent, todo: action.phrase });
        add(event, 'approval', member(agent), `${nameOf(agent)} asked for your approval to ${action.phrase}`, str(data.reason) || undefined);
        break;
      }
      case 'approval.decided': {
        const request = approvals.get(str(data.approval_id));
        const who = nameOf(request?.agentId ?? agentOfRun(event.run_id));
        const what = request ? `: ${request.todo}` : '';
        const note = str(data.note) && event.source === 'user' ? `Your note: ${str(data.note)}` : undefined;
        switch (data.decision) {
          case 'approved':
            add(event, 'approved', 'you', `You approved${what}`, note);
            break;
          case 'rejected':
            add(event, 'declined', 'you', `You rejected${what}`, note);
            break;
          case 'expired':
            add(event, 'declined', null, `No decision was made in time, so ${who} did not go ahead`, request?.todo);
            break;
          case 'cancelled':
            add(event, 'declined', null, `${who}’s approval request was withdrawn because the work stopped`);
            break;
          default:
            break;
        }
        break;
      }

      // ------------------------------------------------------------ the owner's controls and the end
      case 'run.paused':
        add(event, 'pause', 'you', 'You paused the work', 'No new step starts until you resume.');
        break;
      case 'run.unpaused':
        add(event, 'resume', 'you', 'You resumed the work');
        break;
      case 'run.cancel_requested':
        if (isRoot(event)) add(event, 'stop', 'you', 'You asked to stop the work');
        break;
      case 'run.completed':
        if (isRoot(event)) add(event, 'done', null, 'Done: the final result is ready');
        break;
      case 'run.failed':
        if (isRoot(event)) add(event, 'failed', null, 'The task could not be finished', plainError(str(data.error), { names }) ?? undefined);
        break;
      case 'run.cancelled':
        if (isRoot(event)) add(event, 'stop', null, 'The work was stopped');
        break;
      case 'run.interrupted':
        if (isRoot(event)) add(event, 'interrupted', null, 'The work was interrupted because the platform restarted', 'You can continue it from where it stopped.');
        break;
      case 'limit.exceeded': {
        const agent = agentOfRun(event.run_id);
        const limit = str(data.limit);
        const text =
          limit === 'timeout_s'
            ? `${nameOf(agent)} ran out of the time allowed`
            : limit === 'max_steps'
              ? `${nameOf(agent)} reached the maximum number of actions allowed`
              : `${nameOf(agent)} reached the amount of work allowed`;
        add(event, 'limit', member(agent), text);
        break;
      }
      case 'usage.limit':
        if (str(data.status).startsWith('stop')) add(event, 'limit', null, 'Your Claude plan’s usage limit was reached', str(data.message) || undefined);
        break;

      // ------------------------------------------------------------ every action (on demand)
      case 'agent.tool_call':
        calls.set(`${event.run_id}:${str(data.tool_call_id)}`, { tool: str(data.tool), input: data.input });
        break;
      case 'tool.started': {
        const key = `${event.run_id}:${str(data.tool_call_id)}`;
        if (finished.has(key)) break;
        const words = actionWords(str(data.tool), calls.get(key)?.input);
        const agent = agentOfRun(event.run_id);
        if (words) add(event, 'action', member(agent), `${nameOf(agent)} is about to ${words.todo}`, undefined, true);
        break;
      }
      case 'tool.completed':
      case 'tool.failed': {
        const key = `${event.run_id}:${str(data.tool_call_id)}`;
        const words = actionWords(str(data.tool), calls.get(key)?.input);
        const agent = agentOfRun(event.run_id);
        if (!words) break;
        if (event.type === 'tool.completed') add(event, 'action', member(agent), `${nameOf(agent)} ${words.done}`, undefined, true);
        else add(event, 'action-failed', member(agent), `${nameOf(agent)} tried to ${words.todo}, but it did not work`, undefined, true);
        break;
      }
      case 'tool.permission':
        if (data.decision === 'deny') {
          const key = `${event.run_id}:${str(data.tool_call_id)}`;
          const words = actionWords(str(data.tool), calls.get(key)?.input);
          const agent = agentOfRun(event.run_id);
          if (words) add(event, 'action-failed', member(agent), `${nameOf(agent)} was not allowed to ${words.todo}`, 'Your settings block this action.', true);
        }
        break;
      case 'agent.message': {
        const text = str(data.text).trim();
        const agent = agentOfRun(event.run_id);
        if (text) add(event, 'message', member(agent), `${nameOf(agent)} said: “${short(text.replace(/\s+/g, ' '), 240)}”`, undefined, true);
        break;
      }
      default:
        break;
    }
  }
  return items;
}
