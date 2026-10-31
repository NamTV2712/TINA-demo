import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), toggle: vi.fn(), remove: vi.fn() }));
vi.mock('../routinesApi', () => ({ listRoutines: api.list, saveRoutine: api.save, setRoutineEnabled: api.toggle, deleteRoutine: api.remove }));
import { RoutinesBoard } from '../routines';
import { routineCreationPrompt } from '../chat';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const row = { id: 'stable', name: 'Morning', routine_name: 'daily', cron: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh', prompt: 'Read notes', enabled: true, expected_sha256: 'a'.repeat(64), editable: true };
it('persists name, cron, timezone and prompt with the original file precondition', async () => {
  api.list.mockResolvedValue([row]); api.save.mockResolvedValue({});
  render(<RoutinesBoard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Morning' }));
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
  fireEvent.change(screen.getByLabelText('Cron schedule'), { target: { value: '30 9 * * *' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'stable', name: 'Renamed', cron: '30 9 * * *', expected_sha256: row.expected_sha256 })));
  expect(await screen.findByRole('button', { name: 'Edit Morning' })).toBeTruthy();
});
it('keeps a conflicted draft and cancel does not write it', async () => {
  api.list.mockResolvedValue([row]); api.save.mockRejectedValue(new Error('Conflict'));
  render(<RoutinesBoard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Morning' }));
  fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'My draft' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(api.save).toHaveBeenCalled());
  expect((screen.getByLabelText('Task instructions') as HTMLTextAreaElement).value).toBe('My draft');
  fireEvent.click(screen.getByText('Cancel'));
  expect(api.save).toHaveBeenCalledTimes(1);
});
it('toggles and deletes by stable ID, not the editable display name', async () => {
  api.list.mockResolvedValue([row]); api.toggle.mockResolvedValue({}); api.remove.mockResolvedValue({});
  render(<RoutinesBoard />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable Morning' }));
  await waitFor(() => expect(api.toggle).toHaveBeenCalledWith('stable', false, row.expected_sha256));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Delete Morning' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Delete Morning' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('stable', row.expected_sha256));
});
it('authors timezone explicitly and does not claim local cron is UTC', () => {
  const prompt = routineCreationPrompt('/routine mỗi sáng 9 giờ tổng hợp ghi chú', 'Asia/Ho_Chi_Minh');
  expect(prompt).toContain('timezone: "Asia/Ho_Chi_Minh"');
  expect(prompt).toContain('Do not convert clock hours to UTC yourself');
  expect(prompt).toContain('Never overwrite an existing routine file');
});
