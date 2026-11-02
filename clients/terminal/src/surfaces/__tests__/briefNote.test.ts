import { describe, expect, it } from "vitest";
import { briefNotePath, findBriefNote, isExampleNote } from "../briefNote";

const TREE = [
  "README.md",
  "kg/entities/meeting/index.md",
  "kg/entities/meeting/2026-06-12-acme-intro.md",
  "kg/entities/meeting/2026-07-09-zenith-emerging-tech-sig.md",
  "kg/entities/person/jane-liu.md",
];

describe("findBriefNote", () => {
  it('uses the stable row-based path before guessing from titles', () => {
    const path = briefNotePath({ meetingId: '77' });
    expect(path).toBe('kg/entities/meeting/brief-row-77.md');
    expect(findBriefNote([...TREE, path], { meetingId: '77', title: 'Họp kế hoạch' })).toBe(path);
  });
  it('normalizes Vietnamese titles when locating legacy briefs', () => {
    expect(findBriefNote(['kg/entities/meeting/hop-ke-hoach.md'], { title: 'Họp kế hoạch' }))
      .toBe('kg/entities/meeting/hop-ke-hoach.md');
  });
  it('retains a row brief when a meeting link is added later', () => {
    expect(findBriefNote(['kg/entities/meeting/brief-row-77.md', 'kg/entities/meeting/brief-abc-defg-hij.md'],
      { meetingId: '77', nativeId: 'abc-defg-hij', title: 'Họp kế hoạch' }))
      .toBe('kg/entities/meeting/brief-row-77.md');
  });
  it("matches by native id in the filename first (strongest key)", () => {
    const files = [...TREE, "kg/entities/meeting/zenith-sig-91492872876.md"];
    expect(findBriefNote(files, { title: "Something else entirely", nativeId: "91492872876" }))
      .toBe("kg/entities/meeting/zenith-sig-91492872876.md");
  });

  it("falls back to prefix-tolerant title-token overlap (tech ~ technologies)", () => {
    expect(findBriefNote(TREE, { title: "Zenith - Emerging Technologies SIG", nativeId: "999" }))
      .toBe("kg/entities/meeting/2026-07-09-zenith-emerging-tech-sig.md");
  });

  it("prefers the newest occurrence on equal-score series notes", () => {
    const files = [...TREE, "kg/entities/meeting/2026-07-23-zenith-emerging-tech-sig.md"];
    expect(findBriefNote(files, { title: "Zenith - Emerging Technologies SIG" }))
      .toBe("kg/entities/meeting/2026-07-23-zenith-emerging-tech-sig.md");
  });

  it("returns null on weak overlap instead of guessing (honest empty state)", () => {
    expect(findBriefNote(TREE, { title: "Quarterly Budget Review" })).toBeNull();
    expect(findBriefNote(TREE, { title: "" })).toBeNull();
    expect(findBriefNote([], { title: "Zenith SIG" })).toBeNull();
  });

  it("never matches index.md or files outside kg/entities/meeting/", () => {
    expect(findBriefNote(["kg/entities/meeting/index.md", "notes/zenith-sig.md"], { title: "Zenith SIG" })).toBeNull();
  });
});

describe("isExampleNote", () => {
  it("flags seeded demo notes by frontmatter", () => {
    expect(isExampleNote("---\ntype: meeting\nexample: true   # demo\n---\n\n# Acme intro call\n")).toBe(true);
  });
  it("passes real notes", () => {
    expect(isExampleNote("---\ntype: meeting\ntitle: Zenith SIG\n---\n\n# Brief\n")).toBe(false);
    expect(isExampleNote("# no frontmatter at all")).toBe(false);
  });
});
