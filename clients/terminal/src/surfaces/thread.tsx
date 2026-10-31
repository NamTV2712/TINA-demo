"use client";
/** surfaces/thread — the conversation as a CENTER TAB (direction A, law #1: the conversation is the
 *  primary plane, and every record opens BESIDE it).
 *
 *  It renders the very same chat engine as the v1 right rail (`Chat`), so the composer, the streaming
 *  turn timeline, session switching and the /-skills are identical — only the shell around it differs.
 *  `variant="center"` drops the rail's Close button (dockview's tab chrome owns that) and adds the
 *  breadcrumb strip that states what the conversation is grounded on.
 *
 *  Gated on `!meetingsOnly()`, exactly like `chat.tsx`: in the meetings-only build the agent surfaces
 *  never register, so the rail/drawer/thread all stay unmounted there. */
import { registerTab, type TabProps } from "../contributions";
import { Chat } from "./chat";
import { THREAD_TAB_KIND } from "../workbench/shell";
import { meetingsOnly } from "../app/mode";

export function ThreadView({ params }: TabProps) {
  return <Chat params={params} variant="center" />;
}

if (!meetingsOnly()) registerTab(THREAD_TAB_KIND, ThreadView);
