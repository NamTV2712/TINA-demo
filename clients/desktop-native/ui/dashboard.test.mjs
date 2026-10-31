import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadCaptureSettings() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(
    readFileSync(new URL("./capture-settings.js", import.meta.url), "utf8"),
    context
  );
  return context.TinaCaptureSettings;
}

test("audio diagnostics distinguish configured AEC from processed audio and show fallback and clipping", () => {
  const { audioProcessingLabel } = loadCaptureSettings();
  assert.equal(audioProcessingLabel({ running: false }), "Not recording");
  assert.equal(audioProcessingLabel({ running: true, paused: true }), "Paused");
  assert.match(audioProcessingLabel({ running: true }), /Waiting/);
  assert.match(audioProcessingLabel({ running: true, audio_processing: {
    aec: false, fallback_reason: "Desktop lacks sample-index.v1",
  } }), /Original mic.*sample-index/);
  const audio = { aec: true, residual_suppression: true, high_pass_hz: 70, noise_suppression_db: -3 };
  assert.match(audioProcessingLabel({ running: true, audio_processing: audio }), /ready.*waiting.*0 blocks processed/);
  const active = audioProcessingLabel({ running: true, audio_processing: {
    ...audio, processed_blocks: 12, bypassed_samples: 160, mic_clipped_samples: 2,
  } });
  assert.match(active, /AEC processing.*70 Hz.*-3 dB.*12 blocks.*160 samples bypassed.*2 mic samples clipped/);
  assert.doesNotMatch(active, /waiting/);
});

test("capture source selection maps to the audio channels TINA records", () => {
  const settings = loadCaptureSettings();

  assert.deepEqual({ ...settings.audioSourceFlags("both") }, {
    microphone: true,
    systemAudio: true,
  });
  assert.deepEqual({ ...settings.audioSourceFlags("microphone") }, {
    microphone: true,
    systemAudio: false,
  });
  assert.deepEqual({ ...settings.audioSourceFlags("system") }, {
    microphone: false,
    systemAudio: true,
  });
  assert.deepEqual({ ...settings.audioSourceFlags("unknown") }, {
    microphone: true,
    systemAudio: true,
  });
});

test("capture command arguments include every required Tauri field", () => {
  const settings = loadCaptureSettings();

  assert.deepEqual({ ...settings.startCaptureArgs({
    microphone: true,
    systemAudio: false,
    dictation: true,
  }) }, {
    microphone: true,
    systemAudio: false,
    dictation: true,
    liveTranslation: false,
    translationTarget: null,
  });
});

test("live translation arguments preserve the requested language", () => {
  const settings = loadCaptureSettings();

  assert.deepEqual({ ...settings.startCaptureArgs({
    microphone: false,
    systemAudio: true,
    dictation: false,
    liveTranslation: true,
    translationTarget: "vi",
  }) }, {
    microphone: false,
    systemAudio: true,
    dictation: false,
    liveTranslation: true,
    translationTarget: "vi",
  });
});

test("chime preview bypasses the disabled sound preference", () => {
  const settings = loadCaptureSettings();

  assert.equal(settings.shouldPlayChime(false), false);
  assert.equal(settings.shouldPlayChime(false, true), true);
  assert.equal(settings.shouldPlayChime(true), true);
});

test("the main window loads its capture contract helper before app.js", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);

  assert.ok(scripts.indexOf("capture-settings.js") < scripts.indexOf("app.js"));
});

test("Dictation home and history expose accessible controls and reduced-motion states", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

  assert.match(html, /id="dictation-panel" class="mode-panel dictation-panel"/);
  assert.match(html, /id="dictation-toggle"[^>]*aria-pressed=/);
  assert.match(html, /id="history-list"[^>]*role="list"/);
  assert.match(html, /id="history-search"[^>]*aria-label=/);

  const reducedMotionRules = [...css.matchAll(
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
  )].map(match => match[1]);
  assert.ok(reducedMotionRules.some(rule =>
    rule.includes(".recording-dot")
    && rule.includes('#dictation-panel[data-hands-free="true"] .mic-orb')
    && rule.includes("animation: none !important")
  ));
});

test("Dictation home omits its preview while History remains available", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

  assert.doesNotMatch(html, /dictation-home-(?:recent|empty|stats-note|see-all)/);
  assert.doesNotMatch(app, /dictation-home-(?:recent|empty|see-all)/);
  assert.doesNotMatch(css, /dictation-home-(?:recent|empty|stats-note)|dictation-recent-|dictation-row-action/);
  assert.match(html, /data-mode="history"/);
  assert.match(html, /id="history-panel"/);
  assert.match(html, /id="dictation-stat-count"/);
});

test("session transcript keeps timestamp and speaker as separate styled fields", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

  assert.match(app, /meta\.className='transcript-meta'/);
  assert.match(app, /time\.className='transcript-time-range'/);
  assert.match(app, /speaker\.className=`transcript-speaker/);
  assert.match(css, /\.transcript-time-range/);
  assert.match(css, /\.transcript-speaker\.is-you/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});
