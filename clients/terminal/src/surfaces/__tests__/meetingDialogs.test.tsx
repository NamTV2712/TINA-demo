import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MeetingMemory } from "../MeetingMemory";
import { SpeakerRegistry } from "../SpeakerRegistry";
import { TranscriptReview } from "../TranscriptReview";
import { CommandServiceId, createCommandService, createContainer, createKeybindingService, reg } from "../../platform";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open"); this.dispatchEvent(new Event("close"));
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
    url.endsWith("/memory") ? { meeting_id: 6, canonical_revision: 1, windows: [], facts: [] }
    : url.endsWith("/speakers") ? { meeting_id: 6, speakers: [] }
    : url.endsWith("/document") ? { status: "completed", segments: [] }
    : url.endsWith("/alignment") ? { version: "transcript-alignment.v1", available: false, job: null }
    : null,
  )));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["Meeting memory", MeetingMemory],
  ["Speaker identities", SpeakerRegistry],
  ["Review transcript", TranscriptReview],
] as const)("%s consumes Escape without triggering workbench navigation", async (title, Component) => {
  const navigate = vi.fn();
  const container = createContainer([reg(CommandServiceId, createCommandService)]);
  container.get(CommandServiceId).register({ id: "nav.back", title: "Back", run: navigate });
  const keys = createKeybindingService(container);
  keys.register({ key: "Escape", command: "nav.back" });
  const attachment = keys.attach(window);
  try {
    render(<Component meetingId="6" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: title })); });
    const modal = screen.getByRole("dialog", { name: title });
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape", code: "Escape" });
    expect(modal.hasAttribute("open")).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(navigate).toHaveBeenCalledTimes(1);
  } finally { attachment.dispose(); container.dispose(); }
});
