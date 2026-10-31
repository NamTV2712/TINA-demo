import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ui } from '../kit';
vi.mock('../actions', () => ({ useActions: () => ({ ask: vi.fn() }) }));
afterEach(cleanup);

it('shows stale status and reveals the original canonical quote without replacing readable text', () => {
  render(<ui.LiveNotes notes={[{ id: 'a', speaker: 'Alice', text: 'Readable note.', stale: true,
    evidence: [{ quote: 'Tôi sẽ gửi API report.', speaker_name: 'Alice', revision: 2 }] }]} />);
  expect(screen.getByRole('status').textContent).toBe('Out of date');
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByRole('note').textContent).toContain('Tôi sẽ gửi API report.');
  expect(screen.getByText('Readable note.')).toBeTruthy();
});
