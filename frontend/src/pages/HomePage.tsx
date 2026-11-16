// Home: one purpose, "What would you like to accomplish?". Below it: what needs the owner,
// what is in progress and the latest results. Usage figures are in Settings › Usage.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAgents } from '../api/endpoints';
import { qk } from '../api/keys';
import { Page } from '../components/Page';
import { Card, CardBody, ErrorState } from '../components/ui';
import { InProgress, NeedsAttention, RecentWork } from '../features/home/HomeLists';
import { StartTask } from '../features/home/StartTask';
import { ClaudeConnection, useAiAccess } from '../features/onboarding/ClaudeConnection';
import { HowItWorks } from '../features/onboarding/HowItWorks';
import { ProjectFilterNote, useProjectSelection } from '../features/projects/ProjectContext';
import { COORDINATOR_ID } from '../lib/plain';

export function HomePage() {
  const { projectId } = useProjectSelection();
  const agents = useQuery({ queryKey: qk.agents, queryFn: listAgents, staleTime: 60_000 });
  const [runAgent, setRunAgent] = useState<string>(COORDINATOR_ID);
  const provider = agents.data?.items.find((a) => a.id === runAgent)?.effective_provider ?? null;
  const { query: providers, state: access } = useAiAccess(provider);
  const items = agents.data?.items;

  return (
    <Page title="Home">
      <div className="mx-auto max-w-5xl space-y-6">
        <HowItWorks />
        {/* The one primary purpose comes first. */}
        <Card>
          <CardBody className="sm:p-6">
            <StartTask
              agents={items}
              agentsLoaded={agents.isSuccess}
              access={access}
              accessError={providers.isError}
              onAgentChange={setRunAgent}
              belowStart={
                access && access.kind !== 'ready' && access.kind !== 'test' ? (
                  <ClaudeConnection state={access} onCheckAgain={() => void providers.refetch()} checking={providers.isFetching} />
                ) : null
              }
            />
          </CardBody>
        </Card>
        {providers.isError && (
          <ErrorState
            compact
            error={providers.error}
            title="Your Claude connection could not be checked. You can still start."
            onRetry={() => void providers.refetch()}
          />
        )}
        {agents.isError && (
          <ErrorState compact error={agents.error} title="Your team list could not be loaded. You can still start." onRetry={() => void agents.refetch()} />
        )}
        <ProjectFilterNote />
        <NeedsAttention projectId={projectId} agents={items} />
        <InProgress projectId={projectId} agents={items} />
        <RecentWork projectId={projectId} agents={items} />
      </div>
    </Page>
  );
}
