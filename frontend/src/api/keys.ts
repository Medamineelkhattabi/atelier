// TanStack Query keys, in one place so invalidation stays consistent.

import type { ExecutionListParams, RunListParams } from './types';

export const qk = {
  // agent workspace
  workspace: ['workspace'] as const,
  executions: ['workspace', 'executions'] as const,
  executionList: (params: ExecutionListParams) => ['workspace', 'executions', params] as const,
  executionGraph: (rootRunId: string) => ['workspace', 'graph', rootRunId] as const,
  // projects
  projects: ['projects'] as const,
  projectList: (includeArchived: boolean) => ['projects', 'list', includeArchived] as const,
  project: (id: string) => ['projects', 'detail', id] as const,
  projectSecrets: (id: string) => ['secrets', 'project', id] as const,
  auth: ['auth', 'state'] as const,
  dashboard: ['dashboard'] as const,
  runs: ['runs'] as const,
  runList: (params: RunListParams) => ['runs', 'list', params] as const,
  run: (id: string) => ['runs', 'detail', id] as const,
  approvals: ['approvals'] as const,
  approvalList: (status: string) => ['approvals', status] as const,
  agents: ['agents'] as const,
  agent: (id: string) => ['agents', 'detail', id] as const,
  engines: ['engines'] as const,
  tools: ['tools'] as const,
  providers: ['providers'] as const,
  settings: ['settings'] as const,
  secrets: ['secrets'] as const,
  mcp: ['mcp'] as const,
  workspaces: ['workspaces'] as const,
  audit: ['audit'] as const,
  system: ['system'] as const,
  health: ['health'] as const,
};
