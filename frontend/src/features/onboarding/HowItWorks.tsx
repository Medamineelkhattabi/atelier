// First-visit "How it works": one dismissible line. The choice is remembered when the browser allows it.

import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { IconButton } from '../../components/ui';

export const HOW_IT_WORKS_KEY = 'pae.howItWorksHidden';

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HOW_IT_WORKS_KEY) === '1';
  } catch {
    return false;
  }
}

function storeHidden(): void {
  try {
    window.localStorage.setItem(HOW_IT_WORKS_KEY, '1');
  } catch {
    // Storage unavailable (private mode, blocked): hidden for this page only.
  }
}

export function HowItWorks() {
  const [hidden, setHidden] = useState(readHidden);
  if (hidden) return null;
  return (
    <section aria-label="How it works" className="flex items-center gap-2 rounded-md bg-accent-50/70 px-3 py-1.5 text-sm text-zinc-700 dark:bg-accent-950/30 dark:text-zinc-300">
      <Sparkles className="h-4 w-4 shrink-0 text-accent-600 dark:text-accent-400" aria-hidden />
      <p className="min-w-0 flex-1">Describe it, your team does it, and asks you before anything sensitive.</p>
      <IconButton
        label="Hide “How it works”"
        className="h-7 w-7"
        onClick={() => {
          storeHidden();
          setHidden(true);
        }}
      >
        <X className="h-4 w-4" />
      </IconButton>
    </section>
  );
}
