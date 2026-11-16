// My Projects: each project is a separate folder, notes for the team and its own passwords; work
// in one project never mixes with another. List, create, open.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Archive, FolderKanban, Plus, Sparkles } from 'lucide-react';
import { listProjects } from '../api/endpoints';
import { qk } from '../api/keys';
import type { Project } from '../api/types';
import { Page } from '../components/Page';
import { Badge, ButtonLink, EmptyState, ErrorState, LoadingState, Toggle } from '../components/ui';
import { formatRelative } from '../lib/format';

export function ProjectsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const query = useQuery({ queryKey: qk.projectList(showArchived), queryFn: () => listProjects(showArchived) });
  const items = query.data?.items ?? [];

  return (
    <Page
      title="My Projects"
      description="Work in one project never mixes with another."
      help={
        <p>
          A project is its own folder, notes your team reads before every task, and its own passwords. Pick one with “Project:” at the top of the
          screen to see only its work and start new tasks in it.
        </p>
      }
      actions={
        <ButtonLink to="/projects/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
          Create a project
        </ButtonLink>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Toggle checked={showArchived} onChange={setShowArchived} label="Show archived projects" showLabel />
        </div>
        {query.isPending ? (
          <LoadingState label="Loading projects…" />
        ) : query.isError ? (
          <ErrorState error={query.error} title="Your projects could not be loaded." onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <EmptyState
              icon={<FolderKanban className="h-5 w-5" />}
              title={showArchived ? 'No project yet' : 'No active project'}
              action={
                <ButtonLink to="/projects/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
                  Create your first project
                </ButtonLink>
              }
            />
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-label="Projects">
            {items.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const detail = `/projects/${encodeURIComponent(project.id)}`;
  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="space-y-1 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 text-sm font-semibold">
            <Link to={detail} className="text-zinc-900 hover:underline dark:text-zinc-100">
              {project.name}
            </Link>
          </h2>
          {project.archived && (
            <Badge tone="slate">
              <Archive className="h-3 w-3" aria-hidden /> Archived
            </Badge>
          )}
          {!project.archived && project.stats.active > 0 && (
            <Badge tone="blue" dot>
              {project.stats.active} in progress
            </Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {project.stats.runs === 0
            ? 'No task yet'
            : `${project.stats.runs} task${project.stats.runs === 1 ? '' : 's'} · last ${formatRelative(project.stats.last_run_at)}`}
        </p>
        {!project.context.trim() && !project.archived && (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            No notes for your team yet.{' '}
            <Link to={`${detail}?tab=notes`} className="font-medium underline">
              Write them
            </Link>
          </p>
        )}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        {!project.archived && (
          <ButtonLink to={`/?project=${encodeURIComponent(project.id)}`} size="xs" variant="primary" icon={<Sparkles className="h-3.5 w-3.5" />}>
            Start a task here
          </ButtonLink>
        )}
        <ButtonLink to={detail} size="xs">
          Open project
        </ButtonLink>
      </div>
    </li>
  );
}
