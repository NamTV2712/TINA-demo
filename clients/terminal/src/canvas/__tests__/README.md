# canvas tests

Unit tests for the meeting canvas text-processing layer. These tests pin cleanup, tag selection, chaptering, and note-shaping behavior.

- `meetingTranslation.test.tsx` covers exact-source phrase pairing, one English result per group,
  edited-member invalidation, growing Vietnamese tails, recording playback, dropdown changes,
  API retry and isolation when navigating between meetings. Network calls are mocked.
- `meetingCanvasDefaultView.test.tsx` checks the **Song ngữ** dropdown default, then explicitly
  chooses **Tiếng Việt** to verify that existing original/processed switching and AI-note actions
  retain their behavior.

From the repository root:

```bash
pnpm --dir clients/terminal test src/canvas/__tests__
```
