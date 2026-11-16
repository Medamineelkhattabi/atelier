// Page frame: top bar with the page title, at most one short line under it, an optional "?" that
// reveals a short explanation, back link and actions, then content.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { cx } from '../lib/cx';
import { useHelp } from './ui';

export function Page({
  title,
  description,
  help,
  actions,
  back,
  children,
  wide = false,
  documentTitle,
}: {
  title: ReactNode;
  /** One short line under the title (optional). */
  description?: ReactNode;
  /** A short "how this works" text, revealed by the "?" next to the title. */
  help?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  children: ReactNode;
  wide?: boolean;
  documentTitle?: string;
}) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : ''));
  const how = useHelp('How this works');
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-12 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className={cx('mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6', wide ? 'max-w-[1600px]' : 'max-w-7xl')}>
          <div className="min-w-0">
            {back && (
              <Link
                to={back.to}
                className="mb-0.5 inline-flex items-center gap-0.5 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                {back.label}
              </Link>
            )}
            <div className="flex items-center gap-1.5">
              <h1 className="min-w-0 break-words text-lg font-semibold text-zinc-900 dark:text-zinc-50">{title}</h1>
              {help && how.button}
            </div>
            {description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
            {help && how.panel(help, 'mt-2')}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </header>
      <div className={cx('mx-auto w-full flex-1 px-4 py-5 sm:px-6', wide ? 'max-w-[1600px]' : 'max-w-7xl')}>{children}</div>
    </div>
  );
}
