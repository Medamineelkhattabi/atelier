import { afterEach, describe, expect, it } from 'vitest';
import { THEME_KEY, applyTheme, readTheme, saveTheme } from './theme';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('theme', () => {
  it('is light unless the owner chose otherwise', () => {
    expect(readTheme()).toBe('light');
    window.localStorage.setItem(THEME_KEY, 'nonsense');
    expect(readTheme()).toBe('light');
  });

  it('saves the choice and switches the screen', () => {
    saveTheme('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    saveTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    applyTheme('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
