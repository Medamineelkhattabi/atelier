// Settings › Appearance: light or dark screens. The choice is kept in this browser.

import { useId } from 'react';
import { Card, CardBody, CardHeader } from '../../components/ui';
import { cx } from '../../lib/cx';
import { THEME_OPTIONS, useTheme } from '../../lib/theme';

export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const name = useId();
  return (
    <Card>
      <CardHeader title="Screen theme" />
      <CardBody>
        <fieldset>
          <legend className="sr-only">Screen theme</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((option) => (
              <label
                key={option.id}
                className={cx(
                  'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm focus-within:ring-2 focus-within:ring-accent-500',
                  theme === option.id ? 'border-accent-500 bg-accent-50 dark:bg-accent-950/40' : 'border-zinc-200 dark:border-zinc-800',
                )}
              >
                <input type="radio" name={name} className="mt-1" checked={theme === option.id} onChange={() => setTheme(option.id)} />
                <span className="font-medium text-zinc-900 dark:text-zinc-100" title={option.hint}>
                  {option.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </CardBody>
    </Card>
  );
}
