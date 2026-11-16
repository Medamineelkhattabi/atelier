// One typed function per backend endpoint.

import { api, buildUrl } from './client';
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  ExecutionGraph,
  ExecutionListParams,
  ExecutionListResponse,
  PauseResponse,
  Project,
  ProjectListResponse,
  ProjectPatch,
  AgentDefinition,
  AgentDetailResponse,
  AgentListResponse,
  AgentPatch,
  ApprovalListResponse,
  AuditListResponse,
  AuthState,
  CreateRunRequest,
  CreateRunResponse,
  DashboardResponse,
  DecisionRequest,
  FollowUpRequest,
  FollowUpResponse,
  DecisionResponse,
  DeletedResponse,
  EngineListResponse,
  HealthResponse,
  McpListResponse,
  OkResponse,
  Permission,
  ProviderListResponse,
  ClaudeSignInResponse,
  UsageResponse,
  PurgeResponse,
  ReloadResponse,
  RunDetailResponse,
  RunEventsResponse,
  RunListParams,
  RunListResponse,
  SecretListResponse,
  SecretSetResponse,
  SessionOpened,
  SettingsPatch,
  SettingsResponse,
  SystemResponse,
  ToolListResponse,
  ToolPermissionResponse,
  WorkspacesResponse,
} from './types';

const enc = encodeURIComponent;

// auth
export const getAuthState = () => api.get<AuthState>('/api/auth/state');
export const setupOwner = (body: { username: string; password: string; setup_token: string }) =>
  api.post<SessionOpened>('/api/auth/setup', body);
export const login = (body: { username: string; password: string }) =>
  api.post<SessionOpened>('/api/auth/login', body);
export const logout = () => api.post<OkResponse>('/api/auth/logout');
export const changePassword = (body: { current_password: string; new_password: string }) =>
  api.post<OkResponse>('/api/auth/password', body);

// runs
export const createRun = (body: CreateRunRequest) => api.post<CreateRunResponse>('/api/runs', body);
export const listRuns = (params: RunListParams) =>
  api.get<RunListResponse>('/api/runs', {
    project_id: params.project_id,
    origin: params.origin === 'all' ? undefined : (params.origin ?? 'owner'),
    status: params.status,
    agent_id: params.agent_id,
    q: params.q,
    kind: params.kind,
    root_only: params.root_only,
    limit: params.limit,
    offset: params.offset,
  });
export const getRun = (id: string) => api.get<RunDetailResponse>(`/api/runs/${enc(id)}`);
export const getRunEvents = (id: string, after = 0) =>
  api.get<RunEventsResponse>(`/api/runs/${enc(id)}/events`, { after: after || undefined });
export const cancelRun = (id: string) => api.post<{ status: string }>(`/api/runs/${enc(id)}/cancel`);
export const resumeRun = (id: string) => api.post<{ status: string }>(`/api/runs/${enc(id)}/resume`);
/** Continue a finished task with a new instruction: a new task in the same project. */
export const followUpRun = (id: string, body: FollowUpRequest) => api.post<FollowUpResponse>(`/api/runs/${enc(id)}/follow-up`, body);
export const deleteRun = (id: string) => api.delete<DeletedResponse>(`/api/runs/${enc(id)}`);
export const runStreamUrl = (id: string, after = 0) =>
  `/api/runs/${enc(id)}/stream${after ? `?after=${after}` : ''}`;
export const GLOBAL_STREAM_URL = '/api/stream';
/** Root runs only: no new task starts while paused; agents already running finish their current task. */
export const pauseRun = (id: string) => api.post<PauseResponse>(`/api/runs/${enc(id)}/pause`);
export const unpauseRun = (id: string) => api.post<PauseResponse>(`/api/runs/${enc(id)}/unpause`);

// agent workspace
export const getRunGraph = (id: string) => api.get<ExecutionGraph>(`/api/runs/${enc(id)}/graph`);
export const listExecutions = (params: ExecutionListParams = {}) =>
  api.get<ExecutionListResponse>('/api/workspace/executions', {
    project_id: params.project_id,
    status: params.status,
    limit: params.limit,
  });

// approvals
export const listApprovals = (status: 'pending' | 'all' | string = 'pending', limit = 100) =>
  api.get<ApprovalListResponse>('/api/approvals', { status, limit });
export const decideApproval = (id: string, body: DecisionRequest) =>
  api.post<DecisionResponse>(`/api/approvals/${enc(id)}/decision`, body);

// agents and teams
export const listAgents = () => api.get<AgentListResponse>('/api/agents');
export const getAgent = (id: string) => api.get<AgentDetailResponse>(`/api/agents/${enc(id)}`);
export const patchAgent = (id: string, body: AgentPatch) =>
  api.patch<AgentDetailResponse>(`/api/agents/${enc(id)}`, body);
export const resetAgent = (id: string) => api.post<AgentDetailResponse>(`/api/agents/${enc(id)}/reset`);
export const createAgent = (body: Partial<AgentDefinition>) => api.post<AgentDetailResponse>('/api/agents', body);
export const replaceAgent = (id: string, body: Partial<AgentDefinition>) =>
  api.put<AgentDetailResponse>(`/api/agents/${enc(id)}`, body);
export const deleteAgent = (id: string) => api.delete<DeletedResponse>(`/api/agents/${enc(id)}`);
export const reloadAgents = () => api.post<ReloadResponse>('/api/agents/reload');
/** The agents a team member can run on: Claude Code first, then ACP agents (each on its own sign-in). */
export const listEngines = () => api.get<EngineListResponse>('/api/engines');

// admin
export const getDashboard = (days = 30) => api.get<DashboardResponse>('/api/dashboard', { days });
export const getSystem = () => api.get<SystemResponse>('/api/system');
export const getHealth = () => api.get<HealthResponse>('/api/health');
export const listTools = () => api.get<ToolListResponse>('/api/tools');
export const setToolPermission = (name: string, permission: Permission | null) =>
  api.put<ToolPermissionResponse>(`/api/tools/${enc(name)}/permission`, { permission });
export const getUsage = () => api.get<UsageResponse>('/api/usage');
export const clearUsage = () => api.post<{ block: null }>('/api/usage/clear');
export const listProviders = () => api.get<ProviderListResponse>('/api/providers');
/** Opens Anthropic's Claude Code sign-in in a window on this computer (the platform never sees the credential). */
export const openClaudeSignIn = () => api.post<ClaudeSignInResponse>('/api/providers/claude-code/sign-in');
export const getSettings = () => api.get<SettingsResponse>('/api/settings');
export const patchSettings = (body: SettingsPatch) => api.patch<SettingsResponse>('/api/settings', body);
/** Without a project: global secrets. With one: global secrets plus that project's, each with its project_id. */
export const listSecrets = (projectId?: string) => api.get<SecretListResponse>('/api/secrets', { project_id: projectId });
export const putSecret = (name: string, value: string, projectId?: string) =>
  api.put<SecretSetResponse>(buildUrl(`/api/secrets/${enc(name)}`, { project_id: projectId }), { value });
export const deleteSecret = (name: string, projectId?: string) =>
  api.delete<DeletedResponse>(buildUrl(`/api/secrets/${enc(name)}`, { project_id: projectId }));
export const listMcp = () => api.get<McpListResponse>('/api/mcp');
export const restartMcp = () => api.post<McpListResponse>('/api/mcp/restart');
export const getWorkspaces = () => api.get<WorkspacesResponse>('/api/workspaces');
export const listAudit = (limit = 200) => api.get<AuditListResponse>('/api/audit', { limit });
export const purge = (days?: number) => api.post<PurgeResponse>('/api/maintenance/purge', { days: days ?? null });

// projects
export const listProjects = (includeArchived = false) =>
  api.get<ProjectListResponse>('/api/projects', { include_archived: includeArchived });
export const getProject = (id: string) => api.get<Project>(`/api/projects/${enc(id)}`);
export const createProject = (body: CreateProjectRequest) => api.post<CreateProjectResponse>('/api/projects', body);
/** The workspace is fixed once the project exists. */
export const patchProject = (id: string, body: ProjectPatch) => api.patch<Project>(`/api/projects/${enc(id)}`, body);
/** Refused (409) when the project has runs: archive it instead. */
export const deleteProject = (id: string) => api.delete<DeletedResponse>(`/api/projects/${enc(id)}`);

