import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MeetingHealthBanner } from "../MeetingHealthBanner";

const state = vi.hoisted(() => ({
  meeting: { status: "active" },
  diagnostics: {} as Record<string, unknown>,
}));
vi.mock("../useMeeting", () => ({ useMeeting: () => state }));
beforeEach(() => { state.meeting.status = "active"; state.diagnostics = {}; });
afterEach(() => cleanup());

it("keeps a disconnect headline visible and lets the reader expand the cause", () => {
  state.diagnostics = { liveConnected: false, issues: [{ kind: "stream", at: 1, message: "Connection interrupted" }] };
  render(<MeetingHealthBanner />);
  expect(screen.getByText("Reconnecting to live stream…")).toBeTruthy();
  const details = screen.getByText("Details").closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(true);
  expect(screen.getByText("Stream error: Connection interrupted")).toBeTruthy();
});
it("retains dismiss for an actual model issue", () => {
  state.diagnostics = { liveConnected: true, lastTranscriptAt: Date.now(), issues: [{ kind: "model", status: 429, at: 2, message: "Quota reached" }] };
  render(<MeetingHealthBanner />);
  expect(screen.getByText("Model inference error (429)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("status")).toBeNull();
});
it("does not add a notice to a healthy live feed", () => {
  state.diagnostics = { liveConnected: true, lastTranscriptAt: Date.now() };
  render(<MeetingHealthBanner />);
  expect(screen.queryByRole("status")).toBeNull();
});
it("omits the duplicate ended notice only when the recap header owns that status", () => {
  state.meeting.status = "stopped";
  state.diagnostics = { ended: true };
  const view = render(<MeetingHealthBanner />);
  expect(screen.getByText("Meeting ended")).toBeTruthy();
  view.rerender(<MeetingHealthBanner hideEnded />);
  expect(screen.queryByRole("status")).toBeNull();
});
it("keeps live reconnect notices visible even when an ended notice would be hidden", () => {
  state.diagnostics = { liveConnected: false };
  render(<MeetingHealthBanner hideEnded />);
  expect(screen.getByText("Reconnecting to live stream…")).toBeTruthy();
});
