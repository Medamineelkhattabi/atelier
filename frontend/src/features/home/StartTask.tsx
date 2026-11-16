// The request on Home: what the owner wants, for which project, who works on it, then Start.
// In a code project the Software Engineer takes the request directly (one session, like Claude Code) unless
// the owner names someone else; elsewhere the Coordinator decides.
// Start creates the task with the team member's normal AI access (no provider or options) and
// opens it in the Live Workspace. Prefilled from ?task=…&project=…&agent=… (other screens link here).

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bug, FileSearch, FileText, Hammer, Lightbulb, ListChecks, ScanSearch, Search, Send, Sheet, Workflow, type LucideIcon } from 'lucide-react';
import { createRun } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { Agent } from '../../api/types';
import { Button, ErrorState, Textarea } from '../../components/ui';
import { cx } from '../../lib/cx';
import { COORDINATOR_ID, SUGGESTIONS, memberName, type Suggestion } from '../../lib/plain';
import { canStart, notReadyReason, type AccessState } from '../onboarding/aiAccess';
import { useProjectSelection, useProjects } from '../projects/ProjectContext';
import { ProjectChoice } from './ProjectChoice';
import { firstBracket, untouchedPlaceholders } from './templateText';
import { WhoWillWork, pickableMembers } from './WhoWillWork';

const PLACEHOLDER = 'e.g. Compare three project-management tools for a team of five and recommend one.';

/** An icon per suggested activity (the chips show the icon and the title only). */
const SUGGESTION_ICON: Record<string, LucideIcon> = {
  research: Search,
  plan: ListChecks,
  build: Hammer,
  fix: Bug,
  review: ScanSearch,
  docs: FileText,
  extract: FileSearch,
  analyse: Sheet,
  automate: Workflow,
};

export function StartTask({
  agents,
  agentsLoaded,
  access,
  accessError,
  onAgentChange,
  belowStart,
}: {
  agents: Agent[] | undefined;
  /** True once the team list is known (then unavailable team members are replaced by the Coordinator). */
  agentsLoaded: boolean;
  /** AI access of whoever will work on it; null while unknown. */
  access: AccessState | null;
  /** The access could not be checked (the task can still start; the server decides). */
  accessError: boolean;
  /** Tells the page whose AI access to check. */
  onAgentChange: (agentId: string) => void;
  /** Shown right under the Start button (e.g. how to connect the Claude subscription). */
  belowStart?: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { projectId, setProjectId } = useProjectSelection();
  const [text, setText] = useState(() => params.get('task') ?? '');
  // undefined: the owner named nobody (the project's usual member, else the Coordinator); null: the Coordinator.
  const [agentId, setAgentId] = useState<string | null | undefined>(() => (params.get('agent') === null ? undefined : normalizeAgent(params.get('agent'))));
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // A link to Home with other parameters (e.g. "Ask the Researcher") prefills again.
  const taskParam = params.get('task');
  const agentParam = params.get('agent');
  useEffect(() => {
    if (taskParam !== null) setText(taskParam);
  }, [taskParam]);
  useEffect(() => {
    if (agentParam !== null) setAgentId(normalizeAgent(agentParam));
  }, [agentParam]);

  // Place the cursor on the first [bracket] once the template is in the box.
  useEffect(() => {
    if (!selection || !textRef.current) return;
    textRef.current.focus();
    textRef.current.setSelectionRange(selection.start, selection.end);
    setSelection(null);
  }, [selection]);

  const projects = useProjects();
  const directMember = projects.data?.items.find((p) => p.id === projectId)?.direct_member ?? null;
  const available = useMemo(() => new Set(pickableMembers(agents).map((a) => a.id)), [agents]);
  const direct = directMember && (!agentsLoaded || available.has(directMember)) ? directMember : null;
  const wanted = agentId === undefined ? direct : agentId;
  const unavailable = agentsLoaded && wanted !== null && !available.has(wanted) ? wanted : null;
  const effectiveAgent = unavailable ? null : wanted;
  const runAgent = effectiveAgent ?? COORDINATOR_ID;
  useEffect(() => onAgentChange(runAgent), [runAgent, onAgentChange]);

  const start = useMutation({
    mutationFn: () => createRun({ task: text.trim(), agent_id: runAgent, project_id: projectId ?? undefined }),
    onSuccess: ({ run_id }) => {
      void queryClient.invalidateQueries({ queryKey: [...qk.runs, 'list'] });
      void queryClient.invalidateQueries({ queryKey: qk.executions });
      navigate(`/workspace/${run_id}`);
    },
  });

  const ready = canStart(access) || (accessError && !access);
  const waitingReason = accessError && !access ? '' : notReadyReason(access);

  function choose(item: Suggestion) {
    setSuggestion(item);
    setText(item.template);
    setAgentId(item.agentId);
    setProblem(null);
    start.reset();
    setSelection(firstBracket(item.template) ?? { start: item.template.length, end: item.template.length });
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!ready || start.isPending) return;
    const trimmed = text.trim();
    if (!trimmed) {
      setProblem('Describe what you would like first.');
      textRef.current?.focus();
      return;
    }
    const left = untouchedPlaceholders(trimmed, suggestion?.template);
    if (left.length > 0) {
      setProblem(`Replace ${left.join(' and ')} with your own words first.`);
      const at = firstBracket(text);
      if (at) setSelection(at);
      return;
    }
    setProblem(null);
    start.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <label id="home-request-label" htmlFor="home-request" className="block text-lg font-semibold text-zinc-900 dark:text-zinc-50 sm:text-xl">
          What would you like to accomplish?
        </label>
        <Textarea
          ref={textRef}
          id="home-request"
          rows={5}
          value={text}
          placeholder={PLACEHOLDER}
          maxLength={100_000}
          aria-invalid={!!problem}
          aria-describedby={problem ? 'home-request-problem' : undefined}
          className="text-base leading-relaxed"
          onChange={(event) => {
            setText(event.target.value);
            if (problem) setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
          }}
        />
        {problem && (
          <p id="home-request-problem" className="text-xs font-medium text-red-700 dark:text-red-400" role="alert">
            {problem}
          </p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ProjectChoice value={projectId ?? ''} onChange={(id) => setProjectId(id || null)} />
        <WhoWillWork
          agentId={effectiveAgent}
          direct={direct}
          onChange={(id) => setAgentId(id)}
          agents={agents}
          unavailable={unavailable ? memberName(unavailable, agents) : null}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="md" icon={<Send className="h-4 w-4" />} loading={start.isPending} disabled={!ready} aria-describedby={!ready ? 'home-start-reason' : undefined}>
          Start
        </Button>
        {!ready && (
          <p id="home-start-reason" className="min-w-0 flex-1 text-sm text-zinc-700 dark:text-zinc-300">
            {waitingReason}
          </p>
        )}
        {ready && access?.kind === 'test' && (
          <p className="min-w-0 flex-1 text-sm text-violet-800 dark:text-violet-300">Test mode: answers come from a script, not an AI model.</p>
        )}
      </div>
      {start.isError && <ErrorState error={start.error} title="Your task could not start:" />}
      {belowStart}

      <div className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <Lightbulb className="h-4 w-4 text-amber-500" aria-hidden />
          Ideas to get started
        </h2>
        <ul className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((item) => {
            const selected = suggestion?.id === item.id;
            const Icon = SUGGESTION_ICON[item.id] ?? Lightbulb;
            const who = item.agentId ? `By the ${memberName(item.agentId, agents)}` : `Your ${memberName(COORDINATOR_ID, agents)} organises the team`;
            return (
              <li key={item.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={selected}
                  title={`${item.description} ${who}.`}
                  onClick={() => choose(item)}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                    selected
                      ? 'border-accent-400 bg-accent-50 text-accent-800 dark:border-accent-700 dark:bg-accent-950/40 dark:text-accent-200'
                      : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden />
                  {item.title}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </form>
  );
}

/** The Coordinator is the default ("let it decide"): a link that names it means the same thing. */
function normalizeAgent(value: string | null): string | null {
  return !value || value === COORDINATOR_ID ? null : value;
}
