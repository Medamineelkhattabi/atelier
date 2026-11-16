// Settings, in five sections: Claude subscription, Account, Passwords & keys, Usage, Advanced.
// The section is in the address bar (?section=…, plus &part=… inside Advanced). Former links
// (?tab=providers, ?tab=secrets, ?tab=tokens…) lead to the same content in the new place.

import { Link, useSearchParams } from 'react-router-dom';
import { BarChart3, KeyRound, SlidersHorizontal, Sparkles, UserRound, SunMoon } from 'lucide-react';
import type { ComponentType } from 'react';
import { Page } from '../components/Page';
import { AccountSection } from '../features/settings/AccountSection';
import { ADVANCED_PARTS, AdvancedSection, type AdvancedPart } from '../features/settings/AdvancedSection';
import { ClaudeSection } from '../features/settings/ClaudeSection';
import { SecretsSection } from '../features/settings/SecretsSection';
import { UsageSection } from '../features/settings/UsageSection';
import { cx } from '../lib/cx';
import { AppearanceSection } from '../features/settings/AppearanceSection';

export type SettingsSectionId = 'claude' | 'account' | 'appearance' | 'keys' | 'usage' | 'advanced';

const SECTIONS: { id: SettingsSectionId; label: string; description: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'claude', label: 'Claude subscription', description: 'Your team works through your own Claude plan.', icon: Sparkles },
  { id: 'account', label: 'Account', description: 'Your name, automatic approvals and your password.', icon: UserRound },
  { id: 'appearance', label: 'Appearance', description: 'Light or dark screens.', icon: SunMoon },
  { id: 'keys', label: 'Passwords & keys', description: 'For the services your team uses.', icon: KeyRound },
  { id: 'usage', label: 'Usage', description: 'What your team did recently.', icon: BarChart3 },
  { id: 'advanced', label: 'Advanced', description: 'Most people never need these; the defaults are safe.', icon: SlidersHorizontal },
];

/** Former `?tab=` values → section (and part of Advanced). */
const LEGACY_TABS: Record<string, { section: SettingsSectionId; part?: AdvancedPart }> = {
  providers: { section: 'claude' },
  secrets: { section: 'keys' },
  account: { section: 'account' },
  limits: { section: 'advanced', part: 'limits' },
  security: { section: 'advanced', part: 'safety' },
  workspaces: { section: 'advanced', part: 'folders' },
  data: { section: 'advanced', part: 'history' },
  tokens: { section: 'advanced' },
  audit: { section: 'advanced', part: 'audit' },
  system: { section: 'advanced', part: 'system' },
};

export function resolveSettingsLocation(params: URLSearchParams): { section: SettingsSectionId; part: AdvancedPart | null } {
  const legacy = LEGACY_TABS[params.get('tab') ?? ''];
  const requested = params.get('section');
  const section = SECTIONS.some((s) => s.id === requested) ? (requested as SettingsSectionId) : (legacy?.section ?? 'claude');
  const partParam = params.get('part') as AdvancedPart | null;
  const part = partParam && ADVANCED_PARTS.includes(partParam) ? partParam : (legacy?.part ?? null);
  return { section, part: section === 'advanced' ? part : null };
}

export function SettingsPage() {
  const [params] = useSearchParams();
  const { section, part } = resolveSettingsLocation(params);
  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <Page title="Settings">
      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {SECTIONS.map((item) => {
              const active = item.id === section;
              return (
                <li key={item.id}>
                  <Link
                    to={`?section=${item.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                      'ring-1 ring-inset lg:ring-0',
                      active
                        ? 'bg-accent-50 text-accent-800 ring-accent-200 dark:bg-accent-950/60 dark:text-accent-200 dark:ring-accent-900'
                        : 'text-zinc-700 ring-zinc-200 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-50',
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <section aria-labelledby="settings-section-title" className="min-w-0 space-y-4">
          <header>
            <h2 id="settings-section-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {current.label}
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{current.description}</p>
          </header>
          {section === 'claude' && <ClaudeSection />}
          {section === 'account' && <AccountSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'keys' && <SecretsSection />}
          {section === 'usage' && <UsageSection />}
          {section === 'advanced' && <AdvancedSection initialPart={part} />}
        </section>
      </div>
    </Page>
  );
}
