(function (scope) {
  async function polishOrKeepRaw(rawText, polish) {
    const raw = String(rawText ?? "").trim();
    if (!raw) return { text: "", polished: false, unavailable: false };
    try {
      const candidate = await polish(raw);
      const text = typeof candidate === "string" ? candidate.trim() : "";
      if (text) return { text, polished: text !== raw, unavailable: false };
    } catch {
      // Keep the recognized transcript usable when the optional polish service is down.
    }
    return { text: raw, polished: false, unavailable: true };
  }

  function createDictationStateMachine(callbacks = {}, options = {}) {
    const doubleTapThreshold = options.doubleTapThresholdMs ?? 350;
    const clock = options.clock ?? Date;
    const timerSet = options.setTimeout ?? setTimeout;
    const timerClear = options.clearTimeout ?? clearTimeout;

    let state = "IDLE"; // 'IDLE' | 'HOLD_ACTIVE' | 'PENDING_DOUBLE_TAP' | 'HANDS_FREE_ACTIVE' | 'FINISHING'
    let pressTime = 0;
    let doubleTapTimer = null;
    let currentRun = null;

    function setState(nextState, details = {}) {
      state = nextState;
      if (typeof callbacks.onStateChange === "function") {
        callbacks.onStateChange({ state, ...details });
      }
    }

    function handleKeyDown() {
      const now = clock.now();
      if (state === "IDLE") {
        pressTime = now;
        currentRun = { handsFree: false, startedAt: now };
        setState("HOLD_ACTIVE", { mode: "push-to-talk" });
        if (typeof callbacks.onStartCapture === "function") {
          callbacks.onStartCapture(currentRun);
        }
        return;
      }

      if (state === "PENDING_DOUBLE_TAP") {
        // Second tap arrived within doubleTapThreshold!
        if (doubleTapTimer) {
          timerClear(doubleTapTimer);
          doubleTapTimer = null;
        }
        if (currentRun) {
          currentRun.handsFree = true;
        }
        setState("HANDS_FREE_ACTIVE", { mode: "hands-free" });
        if (typeof callbacks.onModeChange === "function") {
          callbacks.onModeChange("hands-free");
        }
        return;
      }

      if (state === "HANDS_FREE_ACTIVE") {
        // Single tap while in hands-free mode -> user wants to stop & finish!
        const run = currentRun;
        currentRun = null;
        setState("FINISHING", { mode: "finish" });
        if (typeof callbacks.onStopCapture === "function") {
          callbacks.onStopCapture(run);
        }
        return;
      }
    }

    function handleKeyUp() {
      const now = clock.now();
      if (state === "HOLD_ACTIVE") {
        const holdDuration = now - pressTime;
        if (holdDuration >= doubleTapThreshold) {
          // Held for >= 350ms: Push-to-Talk completed!
          const run = currentRun;
          currentRun = null;
          setState("FINISHING", { mode: "finish", holdDuration });
          if (typeof callbacks.onStopCapture === "function") {
            callbacks.onStopCapture(run);
          }
        } else {
          // Quick tap (< 350ms): Could be first tap of double-tap!
          setState("PENDING_DOUBLE_TAP", { holdDuration });
          doubleTapTimer = timerSet(() => {
            doubleTapTimer = null;
            if (state === "PENDING_DOUBLE_TAP") {
              const run = currentRun;
              currentRun = null;
              setState("FINISHING", { mode: "finish", singleTap: true });
              if (typeof callbacks.onStopCapture === "function") {
                callbacks.onStopCapture(run);
              }
            }
          }, doubleTapThreshold);
        }
        return;
      }
      // If in HANDS_FREE_ACTIVE: key up after 2nd tap is ignored
    }

    function handleEscape() {
      if (state === "HANDS_FREE_ACTIVE" || state === "HOLD_ACTIVE" || state === "PENDING_DOUBLE_TAP") {
        if (doubleTapTimer) {
          timerClear(doubleTapTimer);
          doubleTapTimer = null;
        }
        const run = currentRun;
        currentRun = null;
        setState("IDLE", { mode: "cancelled" });
        if (typeof callbacks.onCancel === "function") {
          callbacks.onCancel(run);
        }
      }
    }

    function handleToggleClick() {
      if (state === "IDLE") {
        pressTime = clock.now();
        currentRun = { handsFree: true, startedAt: pressTime };
        setState("HANDS_FREE_ACTIVE", { mode: "hands-free" });
        if (typeof callbacks.onStartCapture === "function") {
          callbacks.onStartCapture(currentRun);
        }
      } else {
        if (doubleTapTimer) {
          timerClear(doubleTapTimer);
          doubleTapTimer = null;
        }
        const run = currentRun;
        currentRun = null;
        setState("FINISHING", { mode: "finish" });
        if (typeof callbacks.onStopCapture === "function") {
          callbacks.onStopCapture(run);
        }
      }
    }

    function reset() {
      if (doubleTapTimer) {
        timerClear(doubleTapTimer);
        doubleTapTimer = null;
      }
      state = "IDLE";
      currentRun = null;
      setState("IDLE");
    }

    return {
      getState: () => state,
      getCurrentRun: () => currentRun,
      handleKeyDown,
      handleKeyUp,
      handleEscape,
      handleToggleClick,
      reset,
    };
  }

  scope.TinaDictation = Object.freeze({
    polishOrKeepRaw,
    createDictationStateMachine,
  });
})(globalThis);
