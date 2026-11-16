// App shell: left sidebar (a drawer on small screens), a top bar with the project switcher,
// and the routed page. Also provides the selected project and toasts to every page.

import { useEffect, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardList,
  FolderKanban,
  Home,
  LogOut,
  Moon,
  Sun,
  Menu,
  Plug,
  Settings,
  ShieldQuestion,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { listApprovals } from '../api/endpoints';
import { qk } from '../api/keys';
import { useAuth } from '../auth/AuthProvider';
import { useGlobalStream, type GlobalStreamState } from '../features/live/useGlobalStream';
import { ProjectProvider, ProjectSwitcher } from '../features/projects/ProjectContext';
import { cx } from '../lib/cx';
import { isDark, useTheme } from '../lib/theme';
import { ToastProvider } from './toast';
import { IconButton } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: 'approvals';
  hint: string;
}

/**
 * Navigation follows what the owner wants to do, not how the backend is built.
 * Everyday places first; setup places last. Technical screens (single team member launcher,
 * technical run details, quality checks, team member configuration) live under these.
 */
export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Work',
    items: [
      { to: '/', label: 'Home', icon: Home, end: true, hint: 'Ask for something, and see what needs you' },
      { to: '/workspace', label: 'Live Workspace', icon: Workflow, hint: 'Watch your AI team work on a task, step by step' },
      { to: '/work', label: 'My Work', icon: ClipboardList, hint: 'Everything you asked for, with its results' },
      { to: '/approvals', label: 'Approvals', icon: ShieldQuestion, badge: 'approvals', hint: 'Actions waiting for your decision' },
    ],
  },
  {
    section: 'Organise',
    items: [
      { to: '/team', label: 'My AI Team', icon: Users, hint: 'Who is in your team and what each one does' },
      { to: '/projects', label: 'My Projects', icon: FolderKanban, hint: 'Separate folders, briefs and passwords per project' },
    ],
  },
  {
    section: 'Setup',
    items: [
      { to: '/tools', label: 'Tools & Connections', icon: Plug, hint: 'What your team can use, and services you connect' },
      { to: '/settings', label: 'Settings', icon: Settings, hint: 'Claude subscription, passwords, safety limits, usage' },
    ],
  },
];

function usePendingApprovals(): number {
  const query = useQuery({
    queryKey: qk.approvalList('pending'),
    queryFn: () => listApprovals('pending'),
    refetchInterval: 30_000,
  });
  return query.data?.items.length ?? 0;
}

function LiveIndicator({ state }: { state: GlobalStreamState }) {
  const label = { open: 'Live updates on', connecting: 'Connecting…', reconnecting: 'Reconnecting…', closed: 'Live updates off', unsupported: 'Live updates unavailable' }[state];
  // When all is well, a green dot says it (the words are for screen readers and the tooltip).
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400" title={label}>
      <span
        className={cx('h-1.5 w-1.5 rounded-full', state === 'open' ? 'bg-emerald-500' : state === 'closed' || state === 'unsupported' ? 'bg-red-500' : 'bg-amber-500')}
        aria-hidden
      />
      <span className={state === 'open' ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}

function Sidebar({ pending, stream, onNavigate }: { pending: number; stream: GlobalStreamState; onNavigate?: () => void }) {
  const { username, signOut } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-600 text-xs font-bold text-white" aria-hidden>
          AI
        </span>
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">My AI Team</p>
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((group) => (
          <div key={group.section} className="mb-4">
            <p className="px-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    title={item.hint}
                    className={({ isActive }) =>
                      cx(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                        isActive
                          ? 'bg-accent-50 text-accent-800 dark:bg-accent-950/60 dark:text-accent-200'
                          : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50',
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1">{item.label}</span>
                    {item.badge === 'approvals' && pending > 0 && (
                      <span
                        className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[0.7rem] font-semibold leading-none tabular-nums text-white"
                        aria-label={`${pending} waiting for your approval`}
                      >
                        {pending}
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="space-y-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        {stream !== 'open' && <LiveIndicator state={stream} />}
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {stream === 'open' && <LiveIndicator state={stream} />}
            <span className="truncate text-sm text-zinc-700 dark:text-zinc-300" title="Signed in">
              {username}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <ThemeSwitch />
            <IconButton label="Sign out" onClick={() => void signOut()}>
              <LogOut className="h-4 w-4" />
            </IconButton>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Switches between light and dark screens (Settings › Appearance has "Same as my computer" too). */
function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const dark = isDark(theme);
  return (
    <IconButton label={dark ? 'Switch to light screens' : 'Switch to dark screens'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </IconButton>
  );
}

export function Layout() {
  return (
    <ProjectProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ProjectProvider>
  );
}

function Shell() {
  const pending = usePendingApprovals();
  const stream = useGlobalStream();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 lg:block">
        <Sidebar pending={pending} stream={stream} />
      </aside>

      {/* Top bar: navigation button (small screens), project switcher, approvals shortcut */}
      <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-zinc-200 bg-white px-2 dark:border-zinc-800 dark:bg-zinc-900 sm:px-4 lg:ml-60">
        <IconButton label="Open navigation" onClick={() => setOpen(true)} aria-expanded={open} className="lg:hidden">
          <Menu className="h-5 w-5" />
        </IconButton>
        <span className="hidden text-sm font-semibold text-zinc-900 dark:text-zinc-100 sm:inline lg:hidden">My AI Team</span>
        <ProjectSwitcher className="ml-auto lg:ml-0" />
        {pending > 0 && (
          <NavLink
            to="/approvals"
            className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 lg:ml-auto"
          >
            {pending} to approve
          </NavLink>
        )}
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-zinc-950/40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 w-64 max-w-[85vw] border-r border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="absolute right-2 top-2">
              <IconButton label="Close navigation" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <Sidebar pending={pending} stream={stream} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <main id="main" className="lg:pl-60">
        <Outlet />
      </main>
    </div>
  );
}
