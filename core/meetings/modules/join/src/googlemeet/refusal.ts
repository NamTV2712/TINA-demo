import type { Page } from "playwright";
import { log } from "../_host";
import { AdmissionError } from "../shared/admission";
import { googleJoinRefusedIndicators } from "./selectors";

export const GOOGLE_JOIN_REFUSED = "google_meet_join_refused";
export const GOOGLE_JOIN_MAX_KNOCKS = 3;

const REFUSING_RPC = /(MeetingSpaceService\/ResolveMeetingSpace|MeetingDeviceService\/CreateMeetingDevice)/;
const refusedCall = new WeakMap<object, string>();
const watched = new WeakSet<object>();

/** Attach before navigation: Meet can refuse ResolveMeetingSpace before the lobby finishes loading. */
export function watchGoogleJoinRefusal(page: Page): void {
  const key = page as unknown as object;
  if (watched.has(key) || typeof (page as any).on !== "function") return;
  watched.add(key);
  page.on("response", (response) => {
    try {
      const call = response.status() === 403 ? REFUSING_RPC.exec(response.url())?.[1] : undefined;
      if (call) {
        const detail = `${call.split("/")[1]} answered HTTP 403`;
        refusedCall.set(key, detail);
        log(`Google Meet refused the join: ${detail}`);
      }
    } catch { /* unreadable responses are not refusal evidence */ }
  });
}

export function resetGoogleJoinRefusal(page: Page): void {
  refusedCall.delete(page as unknown as object);
}

export async function checkForGoogleJoinRefused(page: Page): Promise<string | null> {
  const evidence: string[] = [];
  const call = refusedCall.get(page as unknown as object);
  if (call) evidence.push(call);
  for (const selector of googleJoinRefusedIndicators) {
    try {
      if (await page.locator(selector).first().isVisible()) {
        evidence.push("Meet showed ‘You can't join this video call’");
        break;
      }
    } catch { /* a missing or invalid selector is not refusal evidence */ }
  }
  return evidence.length ? evidence.join("; ") : null;
}

export class GoogleJoinRefusedError extends AdmissionError {
  readonly evidence: string;

  constructor(evidence: string, knocks = 1) {
    super(
      "denial",
      `${GOOGLE_JOIN_REFUSED}: Google Meet refused the join on ${knocks} of ${knocks} knock${knocks === 1 ? "" : "s"} (${evidence}); the host never received a request to admit the bot`,
    );
    this.name = "GoogleJoinRefusedError";
    this.evidence = evidence;
  }
}

export async function throwIfGoogleJoinRefused(page: Page, context: string): Promise<void> {
  const evidence = await checkForGoogleJoinRefused(page);
  if (evidence) {
    log(`Google Meet refused the join (${evidence}, ${context})`);
    throw new GoogleJoinRefusedError(evidence);
  }
}

/** Retry only Google's typed flaky refusal; all other outcomes keep their existing handling. */
export async function knockUntilGoogleAccepts(
  page: Page,
  timeoutMs: number,
  knock: (remainingMs: number) => Promise<boolean>,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    resetGoogleJoinRefusal(page);
    try {
      return await knock(Math.max(deadline - now(), 0));
    } catch (error) {
      if (!(error instanceof GoogleJoinRefusedError)) throw error;
      if (attempt >= GOOGLE_JOIN_MAX_KNOCKS || deadline - now() <= 0) {
        throw new GoogleJoinRefusedError(error.evidence, attempt);
      }
      log(`Retrying Google Meet join after refusal ${attempt}/${GOOGLE_JOIN_MAX_KNOCKS}: ${error.evidence}`);
    }
  }
}
