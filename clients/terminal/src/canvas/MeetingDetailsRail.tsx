"use client";

import { useId, useState } from "react";
import type { MeetingMock, MeetingStatusTransition } from "../surfaces/meetingModel";
import type { TranscriptSegment } from "./types";
import styles from "./MeetingDetailsRail.module.css";

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function readableStatus(raw?: string): string {
  if (!raw) return "Status unavailable";
  return raw.replace(/_/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function duration(start?: string, end?: string, live = false): string | undefined {
  if (!start || !end) return live ? "In progress" : undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  const minutes = Math.round((endMs - startMs) / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? (rest ? hours + "h " + rest + "m" : hours + "h") : minutes + "m";
}

function speakerCount(segments: TranscriptSegment[]): number {
  const keys = new Set<string>();
  for (const segment of segments) {
    const name = (segment.speaker ?? "").trim();
    const key = segment.speakerId?.trim() || (name && name.toLowerCase() !== "speaker" ? name.toLowerCase() : "");
    if (key) keys.add(key);
  }
  return keys.size;
}

function wordCount(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + (segment.text.trim().match(/\S+/g)?.length ?? 0), 0);
}

function History({ transitions }: { transitions: MeetingStatusTransition[] }) {
  if (!transitions.length) return null;
  return (
    <details className={styles.historyDisclosure}>
      <summary>Status history <span>{transitions.length}</span></summary>
      <div className={styles.history}>
        {transitions.map((transition, index) => (
          <div className={styles.transition} key={transition.timestamp + "-" + index}>
            <span className={styles.transitionDot} />
            <span>
              {transition.from ? readableStatus(transition.from) + " → " : ""}{readableStatus(transition.to)}
              {transition.reason ? " · " + transition.reason : ""}
              <time className={styles.transitionTime} dateTime={transition.timestamp}>
                {Number.isFinite(Date.parse(transition.timestamp)) ? new Date(transition.timestamp).toLocaleString() : transition.timestamp}
              </time>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

export interface NotesControl {
  message: string;
  label?: string;
  onClick?: () => void;
  busy?: boolean;
  error?: string;
}

export function MeetingDetailsRail({ meeting, segments, recordingAvailable, notesControl, onDeleteMeeting, deletingMeeting = false }: { meeting: MeetingMock; segments: TranscriptSegment[]; recordingAvailable?: boolean; notesControl?: NotesControl; onDeleteMeeting?: () => Promise<string | null>; deletingMeeting?: boolean }) {
  const deleteInputId = useId();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const participants = meeting.participants.filter((person) => person.name.trim());
  const namedAttendees = meeting.attendees?.filter((attendee) => attendee.name?.trim()) ?? [];
  const people = participants.length ? participants : namedAttendees.map((attendee) => ({
    name: attendee.name!.trim(),
    role: "",
    initials: initials(attendee.name!),
  }));
  const hasTranscript = segments.length > 0;
  const groups = speakerCount(segments);
  const words = wordCount(segments);
  const live = meeting.status === "live";
  const status = readableStatus(meeting.live_status ?? meeting.status);
  const meetingWhen = meeting.when.trim();
  const meetingDuration = duration(meeting.start_time, meeting.end_time, live);
  const notes = meeting.notes?.trim();
  const sources = meeting.calendar_sources?.map((source) => source.name.trim()).filter(Boolean) ?? [];

  return (
    <aside aria-label="Meeting information" className={styles.rail}>
      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Meeting Info</h2>
          <span className={styles.sectionMeta}>{meeting.platform}</span>
        </header>
        <div className={styles.rows}>
          <div className={styles.row}><span className={styles.rowLabel}>TINA record</span><span className={styles.rowValue}>{meeting.id}</span></div>
          {meeting.native_id && <div className={styles.row}><span className={styles.rowLabel}>Platform ID</span><span className={styles.rowValue}>{meeting.native_id}</span></div>}
          {meetingWhen && <div className={styles.row}><span className={styles.rowLabel}>When</span><span className={styles.rowValue}>{meetingWhen}</span></div>}
          {meetingDuration && <div className={styles.row}><span className={styles.rowLabel}>Duration</span><span className={styles.rowValue}>{meetingDuration}</span></div>}
          <div className={styles.row}><span className={styles.rowLabel}>Recording data</span><span className={styles.rowValue}>{recordingAvailable || meeting.has_recording ? "Available" : "Not listed"}</span></div>
          {!!meeting.languages?.length && <div className={styles.row}><span className={styles.rowLabel}>Languages</span><span className={styles.rowValue}>{meeting.languages.join(", ")}</span></div>}
          {!!sources.length && <div className={styles.row}><span className={styles.rowLabel}>Imported from</span><span className={styles.rowValue}>{sources.join(", ")}</span></div>}
        </div>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{participants.length ? "Participants" : "Attendees"}</h2>
          <span className={styles.sectionMeta}>{people.length || "—"}</span>
        </header>
        {people.length ? (
          <div className={styles.people}>
            {people.map((person, index) => (
              <div className={styles.person} key={person.name + "-" + index}>
                <span className={styles.initials}>{person.initials || initials(person.name)}</span>
                <span className={styles.personName}>{person.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>No participant names are attached to this meeting record.</p>
        )}
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHeader}><h2 className={styles.sectionTitle}>Details</h2><span className={styles.sectionMeta}>MEETING</span></header>
        <div className={styles.rows}>
          <div className={styles.row}><span className={styles.rowLabel}>Status</span><span className={styles.rowValue + " " + (live ? styles.statusLive : styles.statusValue)}>{status}</span></div>
          <div className={styles.row}><span className={styles.rowLabel}>Speaker groups</span><span className={styles.rowValue}>{hasTranscript ? (groups || "Not attributed") : "Awaiting transcript"}</span></div>
          <div className={styles.row}><span className={styles.rowLabel}>Words</span><span className={styles.rowValue}>{hasTranscript ? words.toLocaleString() : "Awaiting transcript"}</span></div>
          {meeting.status_transition?.length ? <History transitions={meeting.status_transition} /> : null}
        </div>
        {onDeleteMeeting && <div className={styles.deleteControl}>
          {!deleteConfirmOpen ? (
            <>
              <button type="button" className={styles.deleteAction} onClick={() => { setDeleteConfirmText(""); setDeleteError(null); setDeleteConfirmOpen(true); }}>
                Delete meeting
              </button>
              <p className={styles.deleteHelp}>Click to confirm. Transcript and recording data are removed from primary storage; the lifecycle record stays.</p>
            </>
          ) : (
            <div className={styles.deleteConfirm} role="group" aria-label="Confirm meeting deletion">
              <p className={styles.deleteHelp}>Backup copies may persist until your deployment’s retention policy expires them.</p>
              <label className={styles.deleteHelp} htmlFor={deleteInputId}>Type <strong>delete</strong> to continue.</label>
              <input id={deleteInputId} aria-label="Type delete to confirm" autoComplete="off" value={deleteConfirmText} onChange={(event) => { setDeleteConfirmText(event.currentTarget.value); setDeleteError(null); }} />
              <div className={styles.deleteConfirmActions}>
                <button type="button" className={styles.deleteCancel} onClick={() => { setDeleteConfirmOpen(false); setDeleteConfirmText(""); setDeleteError(null); }} disabled={deletingMeeting}>Cancel</button>
                <button type="button" className={styles.deleteAction} onClick={async () => {
                  if (deleteConfirmText.trim().toLowerCase() !== "delete" || deletingMeeting) return;
                  const error = await onDeleteMeeting();
                  if (error) setDeleteError(error);
                  else { setDeleteConfirmOpen(false); setDeleteConfirmText(""); }
                }} disabled={deleteConfirmText.trim().toLowerCase() !== "delete" || deletingMeeting}>
                  {deletingMeeting ? "Deleting…" : "Delete data"}
                </button>
              </div>
              {deleteError && <p className={styles.deleteError} role="alert">{deleteError}</p>}
            </div>
          )}
        </div>}
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHeader}><h2 className={styles.sectionTitle}>Notes</h2><span className={styles.sectionMeta}>MEETING</span></header>
        <p className={notes ? styles.note : styles.empty}>{notes || "No separate meeting notes are stored on this record."}</p>
        {notesControl && <div className={styles.notesControl} role="status">
          <p className={styles.notesStatus}>{notesControl.message}</p>
          {notesControl.label && notesControl.onClick && <button type="button" className={styles.notesAction} onClick={notesControl.onClick} disabled={notesControl.busy}>
            {notesControl.busy ? "Working…" : notesControl.label}
          </button>}
          {notesControl.error && <p className={styles.notesError} role="alert">{notesControl.error}</p>}
        </div>}
      </section>
    </aside>
  );
}
