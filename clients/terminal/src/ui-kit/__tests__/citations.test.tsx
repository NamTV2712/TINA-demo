import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../Markdown';

afterEach(cleanup);
it('renders source titles with escaped punctuation as one safe clickable link', () => {
  render(<Markdown>{'[Python \\[Path\\]\\(guide\\) \\`read_text\\`](https://docs.python.org/3/library/pathlib.html)'}</Markdown>);
  const link = screen.getByRole('link', { name: 'Python [Path](guide) `read_text`' });
  expect(link.getAttribute('href')).toBe('https://docs.python.org/3/library/pathlib.html');
  expect(link.getAttribute('rel')).toContain('noopener');
});
