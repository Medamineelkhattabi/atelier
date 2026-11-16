import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { ApiError } from './api/client';
import { AuthProvider } from './auth/AuthProvider';
import { Layout } from './components/Layout';
import { AgentCreatePage } from './pages/AgentCreatePage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { HomePage } from './pages/HomePage';
import { MyWorkPage } from './pages/MyWorkPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectCreatePage } from './pages/ProjectCreatePage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunPage } from './pages/RunPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamMemberPage } from './pages/TeamMemberPage';
import { TeamPage } from './pages/TeamPage';
import { ToolsPage } from './pages/ToolsPage';
import { WorkspacePage } from './pages/WorkspacePage';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        // Client errors (4xx) will not fix themselves on retry.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

const queryClient = createQueryClient();

/** Opt into React Router v7 behaviour now (silences the v6 deprecation warnings). */
export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

/** Old addresses keep working: they lead to the same place in the new navigation. */
function Redirect({ to }: { to: (params: Record<string, string | undefined>) => string }) {
  const params = useParams();
  const location = useLocation();
  return <Navigate to={`${to(params)}${location.search}`} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        {/* Live Workspace: follow any task (team or single team member), step by step. */}
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="workspace/:runId" element={<WorkspacePage />} />
        <Route path="work" element={<MyWorkPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        {/* My AI Team: profiles first; configuration is a secondary screen. */}
        <Route path="team" element={<TeamPage />} />
        <Route path="team/new" element={<AgentCreatePage />} />
        <Route path="team/checks/*" element={<Redirect to={() => '/team'} />} />
        <Route path="team/:agentId" element={<TeamMemberPage />} />
        <Route path="team/:agentId/settings" element={<AgentDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<ProjectCreatePage />} />
        <Route path="projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        {/* Advanced: technical run details. Tasks start from Home ("Change" picks who works on it). */}
        <Route path="runs/new" element={<Redirect to={() => '/'} />} />
        <Route path="runs/:runId" element={<RunPage />} />
        {/* Former addresses. */}
        <Route path="history" element={<Redirect to={() => '/work'} />} />
        <Route path="teams" element={<Redirect to={() => '/'} />} />
        <Route path="agents" element={<Redirect to={() => '/team'} />} />
        <Route path="agents/new" element={<Redirect to={() => '/team/new'} />} />
        <Route path="agents/:agentId" element={<Redirect to={(p) => `/team/${p.agentId}`} />} />
        <Route path="evals/*" element={<Redirect to={() => '/team'} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={ROUTER_FUTURE}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
