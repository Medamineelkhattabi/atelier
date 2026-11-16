// The selected project: the default filter of Workspace, History, Approvals, Dashboard and the
// launchers. A `?project=<id>` in the URL wins (deep links) and is remembered; otherwise the last
// choice is read from localStorage. null means "All projects".

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban } from 'lucide-react';
import { listProjects } from '../../api/endpoints';
import { qk } from '../../api/keys';
import type { Project } from '../../api/types';
import { Select } from '../../components/ui';
import { cx } from '../../lib/cx';

export const PROJECT_STORAGE_KEY = 'pae.selectedProject';

export function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function storeProject(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
    else window.localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts for this page only.
  }
}

interface ProjectSelection {
  /** null: all projects. */
  projectId: string | null;
  setProjectId: (id: string | null) => void;
}

const ProjectContext = createContext<ProjectSelection>({ projectId: null, setProjectId: () => undefined });

export function useProjectSelection(): ProjectSelection {
  return useContext(ProjectContext);
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('project');
  const [stored, setStored] = useState<string | null>(() => readStoredProject());

  useEffect(() => {
    if (fromUrl === null) return;
    const id = fromUrl || null;
    setStored(id);
    storeProject(id);
  }, [fromUrl]);

  const projectId = fromUrl !== null ? fromUrl || null : stored;

  const setProjectId = useCallback(
    (id: string | null) => {
      setStored(id);
      storeProject(id);
      setParams(
        (current) => {
          if (!current.has('project')) return current;
          const next = new URLSearchParams(current);
          if (id) next.set('project', id);
          else next.delete('project');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const value = useMemo(() => ({ projectId, setProjectId }), [projectId, setProjectId]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/** Active (non-archived) projects, shared by the switcher, pickers and filters. */
export function useProjects() {
  return useQuery({ queryKey: qk.projectList(false), queryFn: () => listProjects(false), staleTime: 30_000 });
}

/** id → name, for labels. */
export function useProjectNames(): Map<string, string> {
  const projects = useProjects();
  return useMemo(() => new Map((projects.data?.items ?? []).map((p) => [p.id, p.name])), [projects.data]);
}

export function projectLabel(id: string | null | undefined, names: Map<string, string>): string {
  if (!id) return 'No project';
  return names.get(id) ?? id;
}

/** Top-bar switcher. */
export function ProjectSwitcher({ className }: { className?: string }) {
  const { projectId, setProjectId } = useProjectSelection();
  const projects = useProjects();
  const items: Project[] = projects.data?.items ?? [];
  const missing = !!projectId && projects.isSuccess && !items.some((p) => p.id === projectId);
  return (
    <div className={cx('flex min-w-0 items-center gap-1.5', className)}>
      <FolderKanban className="hidden h-4 w-4 shrink-0 text-zinc-400 sm:block" aria-hidden />
      <label htmlFor="project-switcher" className="shrink-0 text-xs font-medium text-zinc-600 dark:text-zinc-400">
        Project:
      </label>
      <Select
        id="project-switcher"
        value={projectId ?? ''}
        onChange={(event) => setProjectId(event.target.value || null)}
        className="h-8 min-w-0 max-w-[10rem] py-1 text-sm sm:max-w-[16rem]"
        title="Shows only this project's work, and new tasks start in it. “All projects” shows everything."
      >
        <option value="">All projects</option>
        {items.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        {missing && <option value={projectId}>{projectId} (archived or deleted)</option>}
      </Select>
      {projects.isSuccess && items.length === 0 && (
        <Link to="/projects/new" className="hidden whitespace-nowrap text-xs font-medium text-accent-700 hover:underline dark:text-accent-300 md:inline">
          Create a project
        </Link>
      )}
    </div>
  );
}

/** "Showing project X · Show all projects": tells the owner a page is filtered by the top-bar project. */
export function ProjectFilterNote({ className, extra }: { className?: string; extra?: ReactNode }) {
  const { projectId, setProjectId } = useProjectSelection();
  const names = useProjectNames();
  if (!projectId) return null;
  return (
    <p className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400', className)}>
      <FolderKanban className="h-3.5 w-3.5" aria-hidden />
      <span>
        Project <span className="font-medium text-zinc-800 dark:text-zinc-200">{projectLabel(projectId, names)}</span>
      </span>
      {extra}
      <button
        type="button"
        onClick={() => setProjectId(null)}
        className="rounded font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-accent-300"
      >
        Show all projects
      </button>
    </p>
  );
}

/** The selected project's record, when one is selected and listed. */
export function useSelectedProject(): Project | null {
  const { projectId } = useProjectSelection();
  const projects = useProjects();
  return useMemo(() => (projectId ? (projects.data?.items.find((p) => p.id === projectId) ?? null) : null), [projectId, projects.data]);
}
