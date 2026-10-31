/** term-workbench/shell — the shell-version flag for the Agent-Chat-First redesign (direction A).
 *
 *  v1 (default) — the 3-pane dock: LEFT list · CENTER tabs · RIGHT CHAT (grounded by the active tab).
 *  v2           — the agent-first dock: ICON RAIL · library drawer · CENTER THREAD · right CONTEXT.
 *
 *  The flip lives in `localStorage`, NOT in `NEXT_PUBLIC_*` (which is inlined at build time — see
 *  app/mode.ts): a shell switch has to be visible on a running build without a 4–5 minute image
 *  rebuild. Defaulting to v1 means shipping this module changes NOTHING until someone opts in.
 *
 *  v2 is only honoured by the shell at the `full` tier (≥900px) and never in meetings-only mode —
 *  both gates live in Workbench, next to the other responsive/meetOnly checks. */
import { createStore } from "../platform";

export type ShellVersion = "v1" | "v2";

export const SHELL_LS_KEY = "tina.terminal.shell";
/** the dockview tab-kind the agent-first shell registers as its PRIMARY plane (see surfaces/thread.tsx) */
export const THREAD_TAB_KIND = "thread";

const readFlag = (): ShellVersion => {
  try { return localStorage.getItem(SHELL_LS_KEY) === "v2" ? "v2" : "v1"; } catch { return "v1"; }
};

/** module-scoped (not a DI service) so a surface can read the flag without the container.
 *  The inferred type carries `set`, which `setShellVersion` below drives. */
export const shellStore = createStore<ShellVersion>(readFlag());

export function isShellV2(): boolean { return shellStore.getState() === "v2"; }

/** flip the shell at runtime (persisted). Safe to call in a locked-down storage context — the
 *  in-memory flip still applies for the current page. */
export function setShellVersion(v: ShellVersion): void {
  try { localStorage.setItem(SHELL_LS_KEY, v); } catch { /* storage unavailable — in-memory only */ }
  shellStore.set(v);
}
