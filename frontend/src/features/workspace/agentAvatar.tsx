// A stable colour per agent id, for avatars on the canvas (SVG) and in lists (HTML).

import { cx } from '../../lib/cx';
import { initials } from './graphText';

// Literal class names (Tailwind only generates classes it can see). White text passes AA on all.
const SVG_FILL = ['fill-violet-600', 'fill-teal-700', 'fill-sky-700', 'fill-rose-600', 'fill-indigo-600', 'fill-fuchsia-700', 'fill-cyan-700', 'fill-lime-700'];
const HTML_BG = ['bg-violet-600', 'bg-teal-700', 'bg-sky-700', 'bg-rose-600', 'bg-indigo-600', 'bg-fuchsia-700', 'bg-cyan-700', 'bg-lime-700'];

export function avatarIndex(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return hash % SVG_FILL.length;
}

export function avatarFill(agentId: string): string {
  return SVG_FILL[avatarIndex(agentId)]!;
}

export function AgentAvatar({ agentId, name, size = 'md', className }: { agentId: string; name: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden
      title={name}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-white dark:ring-zinc-900',
        size === 'sm' ? 'h-6 w-6 text-[0.65rem]' : 'h-8 w-8 text-xs',
        HTML_BG[avatarIndex(agentId)],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
