import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, looksLikeMarkdown, shortenText } from './markdown';

const README_GUIDE = `# How to Write a Good README

A README is the **first file** people read.

## 1) What a good README contains

| # | Section | Why it matters |
|---|---------|----------------|
| 1 | **Name** | People decide in seconds |
| 2 | \`Installation\` | They can start |

- Keep it short
- Show an example
  - with real commands

1. Name
2. Usage

> Tip: update it with the code.

\`\`\`bash
pip install tool
\`\`\`

See [the guide](https://example.org/readme).`;

describe('Markdown', () => {
  it('shows headings, bold, tables, lists, quotes and code as formatting, not symbols', () => {
    const { container } = render(<Markdown text={README_GUIDE} />);
    expect(screen.getByRole('heading', { name: 'How to Write a Good README' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1) What a good README contains' })).toBeInTheDocument();
    expect(screen.getByText('first file').tagName).toBe('STRONG');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['#', 'Section', 'Why it matters']);
    expect(within(table).getByText('Name').tagName).toBe('STRONG');
    expect(within(table).getByText('Installation').tagName).toBe('CODE');
    expect(container.querySelectorAll('ul > li').length).toBe(3);
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.querySelector('blockquote')?.textContent).toContain('update it with the code');
    expect(container.querySelector('pre')?.textContent).toBe('pip install tool');
    expect(screen.getByRole('link', { name: 'the guide' })).toHaveAttribute('href', 'https://example.org/readme');
    expect(container.textContent).not.toMatch(/\*\*|\|---|^#/m);
  });

  it('never injects HTML and drops unsafe links', () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> [click](javascript:alert(1)) <script>x</script>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('keeps line breaks of plain text', () => {
    const { container } = render(<Markdown text={'Line one\nLine two'} />);
    expect(container.querySelectorAll('br').length).toBe(1);
  });
});

describe('helpers', () => {
  it('detects Markdown and shortens on a whole line or word', () => {
    expect(looksLikeMarkdown('## Title')).toBe(true);
    expect(looksLikeMarkdown('Just a sentence.')).toBe(false);
    expect(shortenText('alpha beta gamma delta', 13)).toBe('alpha beta…');
    expect(shortenText('short', 50)).toBe('short');
  });
});
