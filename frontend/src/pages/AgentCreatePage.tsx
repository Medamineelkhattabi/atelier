import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { createAgent, listTools } from '../api/endpoints';
import { qk } from '../api/keys';
import { Page } from '../components/Page';
import { Button, Card, CardBody, CardHeader, ErrorState, Field, Mono, RiskBadge, Spinner, Textarea } from '../components/ui';
import { NEW_AGENT_TEMPLATE } from '../lib/agents';
import { parseJson, stringify } from '../lib/json';

const ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function AgentCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tools = useQuery({ queryKey: qk.tools, queryFn: listTools, staleTime: 60_000 });
  const [text, setText] = useState(() => stringify(NEW_AGENT_TEMPLATE));
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: createAgent,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: qk.agents });
      queryClient.setQueryData(qk.agent(data.agent.id), data);
      navigate(`/team/${encodeURIComponent(data.agent.id)}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseJson<Record<string, unknown>>(text, 'object', { allowEmpty: false });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const body = parsed.value ?? {};
    const id = body.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      setError('"id" must be lowercase letters, digits and dashes, starting with a letter (2–63 characters).');
      return;
    }
    for (const key of ['name', 'description', 'instructions']) {
      if (typeof body[key] !== 'string' || !(body[key] as string).trim()) {
        setError(`"${key}" is required.`);
        return;
      }
    }
    setError(null);
    create.mutate(body);
  }

  return (
    <Page
      title="Create a team member (advanced)"
      back={{ to: '/team', label: 'My AI Team' }}
      description="A technical definition (JSON). You rarely need a new member."
    >
      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-3">
          <Field
            label="Team member definition (JSON)"
            htmlFor="new-agent-json"
            error={error ?? undefined}
            hint="Same fields as agents/*.toml; the server validates it."
          >
            <Textarea id="new-agent-json" mono rows={30} value={text} aria-invalid={!!error} onChange={(e) => setText(e.target.value)} />
          </Field>
          {create.isError && <ErrorState error={create.error} title="The server rejected the definition" />}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={<Plus className="h-4 w-4" />} loading={create.isPending}>
              Create team member
            </Button>
          </div>
        </div>
        <aside className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Fields" />
            <CardBody className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
              <p><Mono>provider</Mono>: default or claude-code (your Claude subscription), scripted (test only)</p>
              <p><Mono>effort</Mono>: null, low, medium, high, xhigh, max</p>
              <p><Mono>permissions</Mono>: {'{"tool": "allow" | "ask" | "deny"}'}</p>
              <p><Mono>limits</Mono>: max_steps, timeout_s, max_tokens, max_cost_usd…</p>
              <p><Mono>output_schema</Mono>: JSON Schema object, or null for free text</p>
              <p><Mono>delegates</Mono>: agent ids (requires the agent_delegate tool)</p>
              <p><Mono>claude_code_tools</Mono>: Read, Glob, Grep, Edit, Write, Bash, WebFetch, WebSearch, TodoWrite</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Available tools" />
            <CardBody>
              {tools.isPending ? (
                <Spinner />
              ) : tools.isError ? (
                <ErrorState compact error={tools.error} />
              ) : (
                <ul className="space-y-1.5">
                  {tools.data.items.map((tool) => (
                    <li key={tool.name} className="flex items-center justify-between gap-2 text-xs">
                      <Mono>{tool.name}</Mono>
                      <RiskBadge risk={tool.risk} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </aside>
      </form>
    </Page>
  );
}
