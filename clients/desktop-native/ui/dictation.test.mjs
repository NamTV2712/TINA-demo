import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadDictation() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL("./dictation.js", import.meta.url), "utf8"), context);
  return context.TinaDictation;
}

function createMockEnv(initialTime = 1000) {
  let currentTime = initialTime;
  const timers = new Map();
  let timerIdSeq = 1;

  const clock = {
    now: () => currentTime,
  };

  const mockSetTimeout = (fn, delay) => {
    const id = timerIdSeq++;
    timers.set(id, { fn, triggerAt: currentTime + delay });
    return id;
  };

  const mockClearTimeout = (id) => {
    timers.delete(id);
  };

  const advanceTime = (ms) => {
    currentTime += ms;
    const due = [];
    for (const [id, timer] of timers.entries()) {
      if (currentTime >= timer.triggerAt) {
        due.push({ id, fn: timer.fn });
      }
    }
    for (const item of due) {
      timers.delete(item.id);
      item.fn();
    }
  };

  return { clock, setTimeout: mockSetTimeout, clearTimeout: mockClearTimeout, advanceTime };
}

test("uses polished text after final ASR while retaining the original separately", async () => {
  const dictation = loadDictation();
  const result = await dictation.polishOrKeepRaw("  raw transcript  ", async (text) => {
    assert.equal(text, "raw transcript");
    return " Polished transcript ";
  });

  assert.deepEqual({ ...result }, { text: "Polished transcript", polished: true, unavailable: false });
});

test("keeps raw text when polish rejects or returns an empty result", async () => {
  const dictation = loadDictation();
  const failed = await dictation.polishOrKeepRaw("raw transcript", async () => {
    throw new Error("agent unavailable");
  });
  const empty = await dictation.polishOrKeepRaw("raw transcript", async () => "  ");

  assert.deepEqual({ ...failed }, { text: "raw transcript", polished: false, unavailable: true });
  assert.deepEqual({ ...empty }, { text: "raw transcript", polished: false, unavailable: true });
});

test("does not call polish for an empty transcript", async () => {
  const dictation = loadDictation();
  let called = false;
  const result = await dictation.polishOrKeepRaw("  ", async () => {
    called = true;
    return "unexpected";
  });

  assert.deepEqual({ ...result }, { text: "", polished: false, unavailable: false });
  assert.equal(called, false);
});

test("dictation state machine handles Push-to-Talk (hold >= 350ms)", () => {
  const dictation = loadDictation();
  const env = createMockEnv();
  const events = [];

  const sm = dictation.createDictationStateMachine({
    onStartCapture: (run) => events.push({ type: "start", handsFree: run.handsFree }),
    onStopCapture: () => events.push({ type: "stop" }),
  }, {
    clock: env.clock,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    doubleTapThresholdMs: 350,
  });

  // User presses Fn
  sm.handleKeyDown();
  assert.equal(sm.getState(), "HOLD_ACTIVE");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "start");
  assert.equal(events[0].handsFree, false);

  // User holds for 1200ms
  env.advanceTime(1200);

  // User releases Fn
  sm.handleKeyUp();
  assert.equal(sm.getState(), "FINISHING");
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "stop");
});

test("dictation state machine handles Double-Tap (< 350ms) to enter hands-free mode", () => {
  const dictation = loadDictation();
  const env = createMockEnv();
  const events = [];

  const sm = dictation.createDictationStateMachine({
    onStartCapture: (run) => events.push({ type: "start", handsFree: run.handsFree }),
    onStopCapture: () => events.push({ type: "stop" }),
    onModeChange: (mode) => events.push({ type: "mode", mode }),
  }, {
    clock: env.clock,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    doubleTapThresholdMs: 350,
  });

  // Tap 1 down at t=1000
  sm.handleKeyDown();
  assert.equal(sm.getState(), "HOLD_ACTIVE");
  assert.equal(events.length, 1);

  // Tap 1 up at t=1080 (held 80ms < 350ms)
  env.advanceTime(80);
  sm.handleKeyUp();
  assert.equal(sm.getState(), "PENDING_DOUBLE_TAP");
  // Still capturing! Stop has NOT been called!
  assert.equal(events.length, 1);

  // Tap 2 down at t=1200 (120ms later, within 350ms threshold)
  env.advanceTime(120);
  sm.handleKeyDown();
  assert.equal(sm.getState(), "HANDS_FREE_ACTIVE");
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "mode");
  assert.equal(events[1].mode, "hands-free");

  // Tap 2 up at t=1260: ignored in hands-free mode
  env.advanceTime(60);
  sm.handleKeyUp();
  assert.equal(sm.getState(), "HANDS_FREE_ACTIVE");

  // User speaks freely for 5 seconds
  env.advanceTime(5000);

  // User taps Fn again to finish hands-free dictation
  sm.handleKeyDown();
  assert.equal(sm.getState(), "FINISHING");
  assert.equal(events.length, 3);
  assert.equal(events[2].type, "stop");
});

test("dictation state machine finishes single tap after 350ms timeout if no second tap", () => {
  const dictation = loadDictation();
  const env = createMockEnv();
  const events = [];

  const sm = dictation.createDictationStateMachine({
    onStartCapture: (run) => events.push({ type: "start" }),
    onStopCapture: () => events.push({ type: "stop" }),
  }, {
    clock: env.clock,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    doubleTapThresholdMs: 350,
  });

  // Single tap down & up (60ms)
  sm.handleKeyDown();
  env.advanceTime(60);
  sm.handleKeyUp();
  assert.equal(sm.getState(), "PENDING_DOUBLE_TAP");
  assert.equal(events.length, 1);

  // 350ms passes without a second tap
  env.advanceTime(350);
  assert.equal(sm.getState(), "FINISHING");
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "stop");
});

test("dictation state machine cancels on Escape key", () => {
  const dictation = loadDictation();
  const env = createMockEnv();
  const events = [];

  const sm = dictation.createDictationStateMachine({
    onStartCapture: () => events.push({ type: "start" }),
    onCancel: () => events.push({ type: "cancel" }),
  }, {
    clock: env.clock,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
  });

  sm.handleKeyDown();
  sm.handleEscape();
  assert.equal(sm.getState(), "IDLE");
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "cancel");
});
