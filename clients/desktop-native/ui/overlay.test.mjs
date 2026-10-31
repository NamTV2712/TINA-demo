import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadOverlayUtils() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(
    await readFile(new URL("./overlay-utils.js", import.meta.url), "utf8"),
    context
  );
  return context.TinaOverlayUtils;
}

test("formats durations using the production overlay helper", async () => {
  const { clock } = await loadOverlayUtils();

  assert.equal(clock(0), "00:00");
  assert.equal(clock(5000), "00:05");
  assert.equal(clock(65000), "01:05");
  assert.equal(clock(3665000), "1:01:05");
  assert.equal(clock(-100), "00:00");
});

test("labels detected apps using the production overlay helper", async () => {
  const { appLabel } = await loadOverlayUtils();

  assert.equal(appLabel([]), "Cuộc họp");
  assert.equal(appLabel([{ name: "Zoom" }]), "Zoom");
  assert.equal(appLabel([{ name: "Google Meet" }, { name: "Slack" }]), "Google Meet +1");
});

test("overlay markup contains the controls its renderer addresses", async () => {
  const html = await readFile(new URL("./overlay.html", import.meta.url), "utf8");
  for (const id of [
    "detect", "record", "ended", "result", "dictation", "record-elapsed",
    "record-state", "result-copy", "sourceDropdown", "dict-stop-btn",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing renderer target ${id}`);
  }
});

test("subtitle controls and bundled earcons are present", async () => {
  const startChime = await stat(new URL("./audio/record-start.wav", import.meta.url));
  const endChime = await stat(new URL("./audio/record-end.wav", import.meta.url));
  const subtitles = await readFile(new URL("./subtitles.html", import.meta.url), "utf8");

  assert.ok(startChime.size > 50_000);
  assert.ok(endChime.size > 50_000);
  assert.ok(subtitles.includes('id="smaller"'));
  assert.ok(subtitles.includes('id="larger"'));
  assert.ok(subtitles.includes('id="hide"'));
});
