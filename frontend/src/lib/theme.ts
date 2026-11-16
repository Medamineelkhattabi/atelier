// Screen theme: light (default), dark, or the same as the computer. Kept in this browser only.
// public/theme.js applies it before the page draws; this module changes it while the app runs.

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'pae.theme';

export const THEME_OPTIONS: { id: Theme; label: string; hint: string }[] = [
  { id: 'light', label: 'Light', hint: 'Dark text on a light background.' },
  { id: 'dark', label: 'Dark', hint: 'Light text on a dark background, easier at night.' },
  { id: 'system', label: 'Same as my computer', hint: 'Follows your computer’s light or dark setting.' },
];

export function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === 'dark' || value === 'system' || value === 'light' ? value : 'light';
  } catch {
    return 'light';
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** True when the screen is dark for this choice. */
export function isDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark());
}

export function applyTheme(theme: Theme): void {
  const dark = isDark(theme);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not stored (private window): it still applies until the page is closed.
  }
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent('pae-theme', { detail: theme }));
}

/** The current choice, kept in sync across the switches on screen and with the computer's setting. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const onChange = (event: Event) => setTheme((event as CustomEvent<Theme>).detail);
    window.addEventListener('pae-theme', onChange);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const onSystem = () => {
      if (readTheme() === 'system') applyTheme('system');
    };
    media?.addEventListener?.('change', onSystem);
    return () => {
      window.removeEventListener('pae-theme', onChange);
      media?.removeEventListener?.('change', onSystem);
    };
  }, []);
  return [theme, saveTheme];
}
