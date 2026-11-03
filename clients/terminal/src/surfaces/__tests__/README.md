# surfaces tests

Tests for terminal surface state, gateway websocket handling, and meeting actions. Fixtures live in `fixtures/`.

`settingsModels.test.tsx` verifies that model settings hide manual thinking controls and clear
legacy effort pins when saving. Provider inference behavior is tested in the agent domain;
the language selector and phrase-overlay UI are covered by the [canvas tests](../../canvas/__tests__/README.md).

From the repository root, run `pnpm --dir clients/terminal test src/surfaces/__tests__/settingsModels.test.tsx`
for the settings regression or `pnpm --dir clients/terminal test src/surfaces/__tests__` for this suite.
