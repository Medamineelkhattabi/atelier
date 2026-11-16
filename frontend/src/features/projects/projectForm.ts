// Client-side checks of the project form. The server re-checks everything (the workspace must
// be inside an allowed root, not a root itself, and must not overlap another project).

import type { Project } from '../../api/types';

/** Same folder or below it (case-insensitive, either separator). */
export function isInside(path: string, folder: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const a = norm(path);
  const b = norm(folder);
  return a === b || a.startsWith(`${b}/`);
}

export const NAME_MIN = 2;
export const NAME_MAX = 120;

export function validateName(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Give the project a name.';
  if (value.length < NAME_MIN || value.length > NAME_MAX) return `The name must be ${NAME_MIN} to ${NAME_MAX} characters.`;
  return null;
}

export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]+\\/.test(path) || path.startsWith('/');
}

/**
 * A chosen project folder: empty is fine (the server creates one), otherwise a full path that does not
 * overlap another project's folder. The server refuses unsafe places (a drive, your user folder...).
 */
export function validateWorkspace(path: string, roots: string[], projects: Pick<Project, 'id' | 'name' | 'workspace'>[] = []): string | null {
  const value = path.trim();
  if (!value) return null;
  if (!isAbsolutePath(value)) return 'Use an absolute path, e.g. C:\\…\\my-project.';
  if (roots.some((root) => isInside(root, value) && isInside(value, root))) return 'Choose the project’s own folder, not this location.';
  const overlap = projects.find((p) => isInside(value, p.workspace) || isInside(p.workspace, value));
  if (overlap) return `Already used by project “${overlap.name}”.`;
  return null;
}

export function joinPath(root: string, folder: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const cleanFolder = folder.replace(/^[\\/]+/, '');
  return root.endsWith(separator) ? `${root}${cleanFolder}` : `${root}${separator}${cleanFolder}`;
}

/** Same rule as the server's default project id. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length >= 2 ? slug : `project-${slug || 'x'}`;
}

export const CONTEXT_TEMPLATE = `## Purpose
What this project is for, and who uses the result.

## How things are done
Languages and tools, style, folder layout, naming, how to check that it works (build, tests).

## Limits
What your team must never do here (e.g. no network calls, do not touch /legacy, no new dependencies).

## Done means
How to tell that a task in this project is finished.
`;

/** "Private folders" text (one per line) as relative paths. */
export function parsePrivatePaths(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
}
