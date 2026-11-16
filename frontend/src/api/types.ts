// Types for every object the backend API returns or accepts.
// Source of truth: backend/pae/api/*.py and backend/pae/runtime/*.py.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ------------------------------------------------------------------ auth

export interface AuthState {
  has_owner: boolean;
  authenticated: boolean;
  username: string | null;
  csrf_token: string | null;
}

export interface SessionOpened {
  username: string;
  csrf_token: string;
}

// ------------------------------------------------------------------ runs

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RunKind = 'agent' | 'team';

export type TeamMode = 'sequential' | 'parallel' | 'orchestrated';

export interface RunSummary {
  id: string;
  kind: RunKind;
  agent_id: string | null;
  team_id: string | null;
  parent_run_id: string | null;
  root_run_id: string;
  role: string | null;
  status: RunStatus;
  task: string;
  provider: string | null;
  model: string | null;
  agent_version: string | null;
  steps: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_s: number | null;
  team_name: string | null;
  /** Sums over the run's whole tree (delegations, team members); present in run lists. */
  tree_totals?: TreeTotals | null;
  /** The project the run belongs to (null: no project). */
  project_id?: string | null;
  /** The earlier task this one continues (POST /api/runs/{id}/follow-up), or null. */
  follow_up_of?: string | null;
  /** What a finished security review decided about the change it reviewed; null for any other task. */
  verdict?: ReviewVerdict | null;
}

export type ReviewVerdict = 'pass' | 'pass_with_warnings' | 'block';

/** Where the security review of a task's change stands. "starting": expected, not there yet (run_id null). */
export interface SecurityReviewState {
  run_id: string | null;
  status: RunStatus | 'starting';
  verdict: ReviewVerdict | null;
}

/** POST /api/runs/{id}/follow-up: a new task that continues a finished one. */
export interface FollowUpRequest {
  message: string;
}

export interface FollowUpResponse {
  run_id: string;
  follow_up_of: string;
}

export interface TeamMemberSpec {
  agent: string;
  responsibility: string;
}

export interface TeamSpec {
  id: string;
  name: string;
  description?: string;
  version?: string;
  mode: TeamMode;
  members: TeamMemberSpec[];
  orchestrator?: string | null;
  consolidator?: string | null;
  on_failure?: string;
}

export interface RunDetail extends RunSummary {
  input: JsonObject | null;
  output: JsonValue | null;
  output_text: string | null;
  workspace: string | null;
  limits: Record<string, number> | null;
  resumes: number;
  team: TeamSpec | null;
  scripted: boolean;
  /** Root runs only: no new task of its plans starts while paused. */
  paused?: boolean;
}

export interface TreeTotals {
  steps?: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_calls: number;
  runs: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export type Risk = 'read' | 'write' | 'external' | 'execute' | 'destructive';

export type Permission = 'allow' | 'ask' | 'deny';

export interface Approval {
  id: string;
  run_id: string;
  root_run_id: string;
  agent_id: string;
  tool: string;
  tool_call_id: string | null;
  args: JsonValue;
  risk: Risk | string;
  reason: string | null;
  status: ApprovalStatus;
  note: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
  run_task?: string | null;
  /** The owner's own request this approval belongs to (the task, not the step). */
  root_task?: string | null;
  project_id?: string | null;
}

export interface RunDetailResponse {
  run: RunDetail;
  tree: RunSummary[];
  tree_totals: TreeTotals;
  approvals: Approval[];
  /** The security review of the change this task made, when there is (or will be) one. */
  security_review?: SecurityReviewState | null;
}

export interface RunListResponse {
  total: number;
  items: RunSummary[];
}

export interface RunListParams {
  project_id?: string;
  /** 'owner' (default): the owner's own work; 'quality_check': runs started by quality checks; 'all'. */
  origin?: 'owner' | 'quality_check' | 'all';
  status?: string;
  agent_id?: string;
  q?: string;
  kind?: RunKind | '';
  root_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface RunLimitsInput {
  max_steps?: number;
  timeout_s?: number;
  max_tokens?: number;
  max_cost_usd?: number;
  max_output_tokens?: number;
  [key: string]: number | undefined;
}

export interface AdhocTeamInput {
  mode: TeamMode;
  members: TeamMemberSpec[];
  orchestrator?: string;
  consolidator?: string;
  name?: string;
}

export interface CreateRunRequest {
  task: string;
  agent_id?: string;
  /** The run's workspace then defaults to the project's folder and must stay inside it. */
  project_id?: string;
  team?: { team_id: string } | AdhocTeamInput;
  input?: JsonObject;
  workspace?: string;
  provider?: string;
  model?: string;
  limits?: RunLimitsInput;
  options?: {
    provider_options?: { script: JsonValue[] };
    tree?: { scripts?: Record<string, JsonValue[]> };
  };
}

export interface CreateRunResponse {
  run_id: string;
}

// ------------------------------------------------------------------ events

export type EventSource_ = 'agent' | 'tool' | 'runtime' | 'user';

export type RunEventType =
  // agent
  | 'agent.message'
  | 'agent.reasoning'
  | 'agent.tool_call'
  | 'agent.final'
  // tool
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  // runtime
  | 'run.queued'
  | 'run.started'
  | 'run.resumed'
  | 'run.status'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'step.started'
  | 'model.request'
  | 'model.response'
  | 'model.retry'
  | 'model.error'
  | 'tool.permission'
  | 'approval.requested'
  | 'delegation.started'
  | 'delegation.completed'
  | 'team.member_started'
  | 'team.member_completed'
  | 'team.member_skipped'
  | 'limit.exceeded'
  | 'runtime.note'
  | 'usage.limit'
  // runtime: task plans
  | 'plan.created'
  | 'task.assigned'
  | 'task.started'
  | 'handoff'
  | 'task.retry'
  | 'task.completed'
  | 'task.failed'
  | 'task.skipped'
  | 'plan.completed'
  // user
  | 'approval.decided'
  | 'run.cancel_requested'
  | 'run.paused'
  | 'run.unpaused';

export interface RunEvent {
  id: number;
  run_id: string;
  root_run_id: string;
  seq: number;
  ts: string;
  /** Known types are listed in RunEventType; unknown types are rendered generically. */
  type: RunEventType | (string & {});
  source: EventSource_;
  data: Record<string, unknown>;
}

export interface RunEventsResponse {
  events: RunEvent[];
}

export interface ModelUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  [key: string]: unknown;
}

// ------------------------------------------------------------------ approvals

export interface ApprovalListResponse {
  items: Approval[];
}

export interface DecisionRequest {
  approve: boolean;
  note?: string;
}

export interface DecisionResponse {
  id: string;
  status: ApprovalStatus;
}

// ------------------------------------------------------------------ agents

/** Subscription-only policy: Claude Code on the owner's Claude plan, any ACP agent on its own sign-in
 * (`acp:<engine id>`, e.g. "acp:gemini"), plus the scripted test double. */
export type ProviderName = 'default' | 'claude-code' | 'scripted' | `acp:${string}`;

/** An agent a team member can run on (GET /api/engines): Claude Code, or an ACP agent on its own sign-in. */
export interface Engine {
  /** "claude-code" for the built-in, else e.g. "gemini", "codex", or an id the owner added. */
  id: string;
  /** The value stored as a team member's `provider`: "claude-code" or `acp:<id>`. */
  provider: string;
  name: string;
  /** True only for Claude Code. */
  builtin: boolean;
  /** Its command was found on this computer. */
  installed: boolean;
  /** The command line the platform runs ("" for Claude Code). */
  command: string;
  /** How to install it ("" for Claude Code). */
  install: string;
  /** How to sign in once. */
  sign_in: string;
  /** What it runs on, e.g. "Your Google account". */
  plan: string;
  /** Added by the owner in the settings ("engines.agents"). */
  custom: boolean;
}

export interface EngineListResponse {
  items: Engine[];
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentStatus = 'ready' | 'disabled' | 'misconfigured';

export interface AgentToolDetail {
  name: string;
  available: boolean;
  risk: Risk | null;
  permission: Permission | null;
  description: string;
}

export interface AgentStats {
  runs?: number;
  completed?: number;
  failed?: number;
  active?: number;
  success_rate?: number | null;
  last_run_at?: string | null;
  cost_usd?: number;
}

export interface AgentOverrides {
  provider?: ProviderName | null;
  model?: string | null;
  effort?: Effort | null;
  limits?: Record<string, number> | null;
  permissions?: Record<string, Permission> | null;
  tools?: string[] | null;
  instructions?: string | null;
}

/** The editable definition (what agents/*.toml and POST/PUT /api/agents contain). */
export interface AgentDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  purpose: string;
  capabilities: string[];
  provider: ProviderName;
  model: string | null;
  effort: Effort | null;
  instructions: string;
  tools: string[];
  claude_code_tools: string[];
  delegates: string[];
  permissions: Record<string, Permission>;
  limits: Record<string, number>;
  output_schema: JsonObject | null;
  input_hint: string;
  tags: string[];
}

export interface Agent extends AgentDefinition {
  /** One sentence: what this agent is accountable for. */
  responsibility?: string;
  /** What it does NOT do (and hands off instead). */
  boundaries?: string[];
  /** Agent ids it typically hands off to. */
  works_with?: string[];
  /** Plain-language situations where this team member helps. */
  when_to_use?: string[];
  tools_detail: AgentToolDetail[];
  effective_provider: string;
  effective_model: string | null;
  status: AgentStatus;
  source: 'file' | 'custom';
  enabled: boolean;
  overrides: AgentOverrides;
  revision: string;
  updated_at: string | null;
  problems: string[];
  stats: AgentStats;
}

export interface AgentListResponse {
  items: Agent[];
  load_errors: Record<string, string>;
}

export interface AgentDetailResponse {
  agent: Agent;
  recent_runs: RunSummary[];
  toml: string;
}

export interface AgentPatch {
  enabled?: boolean;
  overrides?: AgentOverrides;
}

export interface ReloadResponse {
  agents: number;
  load_errors: Record<string, string>;
}

export interface Team extends TeamSpec {
  source: 'file' | 'custom';
  enabled: boolean;
}

export interface TeamListResponse {
  items: Team[];
}

export interface SaveTeamRequest {
  id: string;
  name: string;
  description?: string;
  mode: TeamMode;
  members: TeamMemberSpec[];
  orchestrator?: string | null;
  consolidator?: string | null;
}

export interface DeletedResponse {
  deleted: string;
}

// ------------------------------------------------------------------ admin

/** How the claude-code provider authenticates (GET /api/providers). */
/** login: signed in with `pae claude-login`; env_token: CLAUDE_CODE_OAUTH_TOKEN in the environment;
 * blocked: paid credential variables found; none: not signed in. */
export type ClaudeCodeAuth = 'login' | 'env_token' | 'blocked' | 'none';

/** Set when Claude Code reported that the plan's usage limit was reached. */
export interface UsageBlock {
  blocked_until: string;
  window: string | null;
  reason: 'limit' | 'overage';
  message: string;
}

export interface UsageResponse {
  policy: string;
  block: UsageBlock | null;
}

export interface ProviderStatus {
  name: string;
  description: string;
  default_model: string | null;
  is_default: boolean;
  configured: boolean;
  /** Human-readable state, including how to fix it. */
  detail: string;
  /** claude-code only. */
  cli_path?: string | null;
  /** claude-code only. */
  auth?: ClaudeCodeAuth;
  /** claude-code only: the platform's Claude Code home (holds the sign-in; never read by the platform). */
  config_dir?: string;
  /** claude-code only. */
  usage?: UsageBlock | Record<string, never>;
  policy?: string;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env_secrets?: Record<string, string> | string[];
  enabled?: boolean;
  permission?: Permission;
  [key: string]: unknown;
}

export interface McpServerStatus {
  name: string;
  status: string;
  error: string | null;
  tools: string[];
  config: McpServerConfig;
}

export interface DashboardActivity {
  id: number;
  run_id: string;
  type: string;
  source: EventSource_;
  ts: string;
  data: Record<string, unknown>;
}

export interface DashboardResponse {
  agents: { total: number; enabled: number };
  runs: { running: number; by_status: Partial<Record<RunStatus, number>> };
  window: {
    days: number;
    runs: number;
    completed: number;
    failed: number;
    success_rate: number | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  per_day: { date: string; runs: number; completed: number; cost_usd: number }[];
  pending_approvals: number;
  recent_runs: RunSummary[];
  activity: DashboardActivity[];
  providers: ProviderStatus[];
  mcp: McpServerStatus[];
}

export interface SystemResponse {
  version: string;
  uptime_s: number;
  active_runs: number;
  max_concurrent_runs: number;
  data_dir: string;
  disk_free_gb: number;
  providers: ProviderStatus[];
  mcp: McpServerStatus[];
  agents_dir: string;
  agent_load_errors: Record<string, string>;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: string;
  version: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  risk: Risk;
  default_permission: Permission;
  untrusted_output: boolean;
  timeout_s: number;
  input_schema: JsonObject;
  source: string;
  global_permission: Permission | null;
  used_by: string[];
}

export interface ToolListResponse {
  items: ToolInfo[];
}

export interface ToolPermissionResponse {
  name: string;
  global_permission: Permission | null;
}

export interface ProviderListResponse {
  items: ProviderStatus[];
}

export interface SettingsValues {
  'providers.default': string;
  'providers.claude_code.default_model': string | null;
  'providers.claude_code.cli_path': string | null;
  'limits.max_steps': number;
  'limits.timeout_s': number;
  'limits.max_tokens': number;
  'limits.max_cost_usd': number;
  'limits.max_output_tokens': number;
  'limits.max_concurrent_runs': number;
  'limits.max_delegation_depth': number;
  'limits.max_children_per_run': number;
  'limits.max_parallel_members': number;
  'limits.provider_retries': number;
  'limits.approval_timeout_s': number;
  'limits.tool_output_chars': number;
  'permissions.tools': Record<string, Permission>;
  /** 'auto': actions run without asking (like Claude Code's bypass mode), except deploying, pushing, publishing,
   *  sending data out and leaving the project. */
  'permissions.mode': 'ask' | 'auto' | 'all';
  /** The owner's name, used by the team (the Claude account may show another name). */
  'owner.name': string;
  'watch.interval_s': number;
  'watch.diagnose': boolean;
  'watch.max_diagnoses_per_day': number;
  'notifications.windows': boolean;
  'http.allowed_domains': string[];
  'http.allow_private_network': boolean;
  'shell.sandbox': 'none' | 'docker';
  'shell.docker_image': string;
  'email.smtp': JsonObject;
  'mcp.servers': McpServerConfig[];
  'workspaces.roots': string[];
  'retention.days': number;
  'logging.store_tool_outputs': boolean;
}

export type SettingKey = keyof SettingsValues;

export interface SettingsResponse {
  values: SettingsValues;
}

export type SettingsPatch = Partial<SettingsValues>;

export interface SecretInfo {
  name: string;
  hint: string;
  source: 'stored' | 'environment';
  updated_at: string | null;
  /** null (or absent): a global secret, visible to every run. */
  project_id?: string | null;
}

export interface SecretListResponse {
  items: SecretInfo[];
}

export interface SecretSetResponse {
  name: string;
  hint: string;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
}

export interface TokenListResponse {
  items: ApiTokenInfo[];
}

export interface TokenCreated {
  name: string;
  token: string;
  note: string;
}

export interface McpListResponse {
  items: McpServerStatus[];
}

export interface WorkspacesResponse {
  default: string;
  roots: { root: string; directories: string[] }[];
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditListResponse {
  items: AuditEntry[];
}

export interface PurgeResponse {
  removed_runs: number;
}

export interface OkResponse {
  ok: boolean;
  note?: string;
}

// ------------------------------------------------------------------ projects

export interface ProjectCapability {
  name: string;
  description: string;
  requires: string[];
}

export interface ProjectCapabilitiesResponse {
  items: ProjectCapability[];
}

export interface BootstrapRequest {
  directory: string;
  capabilities: string[];
  name?: string;
  force?: boolean;
}

export interface BootstrapResponse {
  directory: string;
  files: string[];
}

export interface ProjectStats {
  runs: number;
  active: number;
  last_run_at: string | null;
}

/** A project: one workspace folder, a brief given to every agent run in it, its own secrets. */
export interface Project {
  id: string;
  name: string;
  description: string;
  workspace: string;
  /** The project brief: purpose, conventions, constraints. Given to every agent run in the project. */
  context: string;
  tags: string[];
  /** Paths inside the folder (relative) that no team member may open: backups, logs, real data. */
  private_paths?: string[];
  /** Who takes a request here when the owner names nobody: in a code project the Software Engineer, alone and at
   *  once (like a Claude Code session); null: the Coordinator decides. */
  direct_member?: string | null;
  /** True when the folder is an existing folder outside the platform's own locations. */
  external?: boolean;
  /** File edits (fs_write) in this project run without asking; commands and deletions still ask. */
  trust_edits?: boolean;
  /** Claude Code's memory for this folder, when the owner already worked on it with Claude Code:
   *  its index is given to every task, and single notes can be opened. */
  claude_memory?: { notes: number; folder: string } | null;
  /** The platform watches the project's running app (Docker Compose): `available` when the folder has one. */
  watch?: { on: boolean; available: boolean };
  archived: boolean;
  created_at: string;
  updated_at: string;
  stats: ProjectStats;
}

export interface ProjectListResponse {
  items: Project[];
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  /** An existing folder anywhere on this computer; omitted: the platform creates one. */
  workspace?: string;
  context?: string;
  tags?: string[];
  private_paths?: string[];
  /** Bootstrap capabilities to write into the new workspace. */
  scaffold?: string[];
}

export interface CreateProjectResponse extends Project {
  /** Present when the project was scaffolded. */
  files?: string[];
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  context?: string;
  tags?: string[];
  private_paths?: string[];
  trust_edits?: boolean;
  watch?: { on: boolean };
  archived?: boolean;
}

export interface ScaffoldRequest {
  capabilities: string[];
  force?: boolean;
}

export interface ScaffoldResponse {
  files: string[];
}

// ------------------------------------------------------------------ agent workspace

export interface PauseResponse {
  paused: boolean;
}

export interface NodeUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_s: number | null;
  steps: number;
  tool_calls: number;
}

export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'retrying' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export type ResultStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface RootGraphNode {
  id: string;
  kind: 'root';
  run_id: string;
  agent_id: string | null;
  team_id: string | null;
  /** Who runs the root: the agent's or team's name (the objective is ExecutionGraph.title). */
  label: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  /** Usage of the root run itself (not of its tree). */
  usage: NodeUsage;
  error: string | null;
}

export interface TaskGraphNode {
  id: string;
  kind: 'task';
  plan_id: string;
  task_id: string;
  /** Node id of the root, or of the task whose agent planned this task (nested plan). */
  parent_id: string;
  agent_id: string;
  title: string;
  /** Why this agent was chosen for the task. */
  reason: string;
  /** Node ids. */
  depends_on: string[];
  status: TaskStatus;
  attempts: number;
  run_ids: string[];
  current_run_id: string | null;
  input_summary: string;
  output_preview: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  usage: NodeUsage;
  tools_used: Record<string, number>;
  pending_approvals: number;
}

export interface ApprovalGraphNode {
  id: string;
  kind: 'approval';
  approval_id: string;
  run_id: string;
  /** Node id of the task (or root) the approval gate belongs to. */
  attached_to: string;
  tool: string;
  risk: string;
  status: ApprovalStatus;
  reason: string | null;
  args: Record<string, unknown>;
}

export interface ResultGraphNode {
  id: string;
  kind: 'result';
  status: ResultStatus;
  output_preview: string | null;
}

export type GraphNode = RootGraphNode | TaskGraphNode | ApprovalGraphNode | ResultGraphNode;

export type GraphEdgeKind = 'delegates' | 'depends_on' | 'handoff' | 'approval' | 'consolidates';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** True only while the target is actually running or waiting: the only edges that may be animated. */
  active: boolean;
  label?: string;
}

/** GET /api/runs/{id}/graph: the execution graph of the run's tree, rebuilt from persisted events. */
export interface ExecutionGraph {
  root_run_id: string;
  project_id: string | null;
  status: RunStatus;
  paused: boolean;
  /** The objective (the root run's task). */
  title: string;
  last_event_id: number;
  agents: Record<string, { name: string; responsibility: string }>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Each task counted once, from its latest state (retries and resumed plans are not double-counted). */
export interface ExecutionTaskCounts {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  running: number;
}

/** A collaborative run: a team run, or an agent run that delegated at least once. */
export interface ExecutionSummary {
  run_id: string;
  title: string;
  kind: RunKind;
  agent_id: string | null;
  team_name: string | null;
  project_id: string | null;
  status: RunStatus;
  paused: boolean;
  created_at: string;
  finished_at: string | null;
  agents: string[];
  tasks: ExecutionTaskCounts;
  /** Child runs currently running or waiting for approval. */
  active_runs: number;
  pending_approvals: number;
}

export interface ExecutionListResponse {
  items: ExecutionSummary[];
}

export interface ExecutionListParams {
  project_id?: string;
  status?: string;
  limit?: number;
}

// ------------------------------------------------------------------ evals

export interface EvalCaseInfo {
  id: string;
  category: string;
  agent: string | null;
  team: boolean;
}

export interface EvalSummary {
  cases?: number;
  passed?: number;
  pass_rate?: number | null;
  by_category?: Record<string, { cases: number; passed: number; pass_rate: number }>;
  total_cost_usd?: number;
  median_duration_s?: number | null;
  max_duration_s?: number | null;
  error?: string;
}

export interface EvalRunInfo {
  id: string;
  suite: string;
  status: 'running' | 'completed' | 'failed' | string;
  provider: string | null;
  summary: EvalSummary | null;
  started_at: string;
  finished_at: string | null;
}

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalCaseResult {
  case: string;
  category: string;
  run_id: string | null;
  status?: RunStatus;
  passed: boolean;
  checks: EvalCheck[];
  duration_s: number;
  steps?: number;
  tool_calls?: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface EvalRunDetail extends EvalRunInfo {
  results: EvalCaseResult[] | null;
}

export interface EvalSuite {
  id: string;
  name: string;
  description: string;
  provider: string | null;
  live: boolean;
  cases: EvalCaseInfo[];
  latest: EvalRunInfo | null;
}

export interface EvalSuiteListResponse {
  items: EvalSuite[];
  errors: Record<string, string>;
}

export interface EvalRunRequest {
  provider?: string;
  cases?: string[];
}

export interface EvalRunCreated {
  eval_run_id: string;
}

export interface EvalRunListResponse {
  items: EvalRunInfo[];
}

// ------------------------------------------------------------------ errors

/** FastAPI request validation errors (422) carry a list instead of a string. */
export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export interface ErrorBody {
  detail: string | ValidationIssue[] | unknown;
}

/** Result of asking the platform to open Anthropic's Claude Code sign-in window on this computer. */
export interface ClaudeSignInResponse {
  opened: boolean;
  /** Why no window could be opened (then `command` must be run in a terminal). */
  reason: string;
  command: string;
}
