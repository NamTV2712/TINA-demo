"use client";
import { AgentChat } from './agent-chat';

export function MeetingAgentPanel({ meetingId, platform }: { meetingId: string; platform: string }) {
  return <AgentChat meetingId={meetingId} platform={platform} />;
}
