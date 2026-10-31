const invoke=window.__TAURI__?.core?.invoke;
if(typeof invoke!=='function')throw new Error('TINA Capture overlay requires the Tauri runtime');
const $ = (id) => document.getElementById(id);
const { clock, appLabel }=window.TinaOverlayUtils;

const POLL_MS = 300;
const MODES = ['detect', 'record', 'ended', 'result', 'dictation'];
let mode = 'hidden';
let busy = false;
let timer = 0;

// Track last known state for the Result Toast
let lastKnownElapsedMs = 0;
let lastKnownSnippet = '';
let lastKnownApps = [];
let isPill = localStorage.getItem('tina.overlay.is_pill') === 'true';

// Result Toast Countdown & Pause-on-Hover
let resultStartTime = 0;
let resultRemainingMs = 6000;
let resultTimeout = null;
let isResultHovered = false;

function getAppVisual(appName) {
  const lower = (appName || '').toLowerCase();
  if (lower.includes('zoom')) {
    return {
      bg: '#2D8CFF',
      svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h8A2.5 2.5 0 0 1 17 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 4 17.5v-11z"/><path d="m17 9.5 4-2.5v10l-4-2.5v-5z"/></svg>'
    };
  }
  if (lower.includes('teams')) {
    return {
      bg: '#6264A7',
      svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M19.5 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-7-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1.5c-3 0-5.5 1.5-5.5 3.5v3h11v-3c0-2-2.5-3.5-5.5-3.5zm7 2.5c-.4 0-.8.1-1.2.2.4.7.7 1.4.7 2.3v2.5H23v-2.5c0-1.4-1.6-2.5-3.5-2.5z"/></svg>'
    };
  }
  if (lower.includes('meet') || lower.includes('chrome')) {
    return {
      bg: '#00AC47',
      svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>'
    };
  }
  if (lower.includes('slack')) {
    return {
      bg: '#4A154B',
      svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M6 15a2 2 0 1 1-2-2h2v2zm1 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2v5a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-5zm2-7a2 2 0 1 1 2-2v2H9zm0 1a2 2 0 0 1 2 2 2 2 0 0 1-2 2H4a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5zm7 2a2 2 0 1 1 2 2h-2v-2zm-1 0a2 2 0 0 1-2 2 2 2 0 0 1-2-2V5a2 2 0 0 1 2-2 2 2 0 0 1 2 2v5zm-2 7a2 2 0 1 1-2 2v-2h2zm0-1a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-5z"/></svg>'
    };
  }
  return {
    bg: '#5B6BF5',
    svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2"><path d="m16 10 5-3v10l-5-3M3 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>'
  };
}

// Meeting Detect Countdown & Hover
let detectRemainingMs = 15000;
let detectStartTime = 0;
let isDetectHovered = false;
let detectInterval = null;

function startDetectCountdown() {
  if (detectInterval) clearInterval(detectInterval);
  detectRemainingMs = 15000;
  detectStartTime = Date.now();
  
  detectInterval = setInterval(() => {
    if (mode !== 'detect') {
      clearInterval(detectInterval);
      detectInterval = null;
      return;
    }
    if (!isDetectHovered) {
      detectRemainingMs -= 150;
      const progress = Math.max(0, Math.min(1, detectRemainingMs / 15000));
      const fill = $('detect-progress-fill');
      if (fill) fill.style.transform = `scaleX(${progress.toFixed(3)})`;
      
      if (detectRemainingMs <= 0) {
        clearInterval(detectInterval);
        detectInterval = null;
        act('dismiss');
      }
    }
  }, 150);
}

// ─── Speakly Organic Equalizer Engine ─────────────────────────────
// Symmetrical Parabolic Profiles
// Capsule (7 bars): center bars taller, outer bars taper smoothly
const CAPSULE_BARS = 7;
const CAPSULE_PROFILE = [0.42, 0.74, 0.93, 1.0, 0.93, 0.74, 0.42];
const CAPSULE_MIN_H = 2.5;
const CAPSULE_MAX_H = 16.0;

// Mini Pill (5 bars): symmetrical compact curve
const PILL_BARS = 5;
const PILL_PROFILE = [0.48, 0.82, 1.0, 0.82, 0.48];
const PILL_MIN_H = 2.0;
const PILL_MAX_H = 12.0;

const OSC_FREQ = 3.0;
const OSC_AMP = 0.15;
const PHASE_OFFSET = 0.75;

const capsuleHistory = new Array(CAPSULE_BARS).fill(0);
const pillHistory = new Array(PILL_BARS).fill(0);
let currentAudioLevel = 0;
let targetAudioLevel = 0;
let isAudioPaused = false;

function feedAudioLevel(level, paused) {
  isAudioPaused = Boolean(paused);
  if (isAudioPaused) {
    targetAudioLevel = 0;
  } else {
    const raw = Math.max(0, Math.min(1, Number(level) || 0));
    targetAudioLevel = Math.min(1, Math.sqrt(raw) * 2.2 + 0.02);
  }
}

function tickWaveform() {
  const lerp = targetAudioLevel > currentAudioLevel ? 0.35 : 0.18;
  currentAudioLevel += (targetAudioLevel - currentAudioLevel) * lerp;

  const energy = currentAudioLevel < 0.01 ? 0 : currentAudioLevel;
  capsuleHistory.shift();
  capsuleHistory.push(energy);

  pillHistory.shift();
  pillHistory.push(energy);

  const now = performance.now();

  // 1. Animate horizontal capsule wave bars (7 bars)
  const capsuleBars = document.querySelectorAll('#waveformSection .wave-bar');
  capsuleBars.forEach((bar, idx) => {
    const e = capsuleHistory[idx] || 0;
    if (e <= 0.01) {
      bar.style.height = `${CAPSULE_MIN_H}px`;
      return;
    }
    const wave = 1 + OSC_AMP * Math.sin((now / 1000) * 2 * Math.PI * OSC_FREQ + idx * PHASE_OFFSET);
    const range = (CAPSULE_MAX_H - CAPSULE_MIN_H) * 0.95;
    const computed = CAPSULE_MIN_H + range * e * wave * CAPSULE_PROFILE[idx];
    bar.style.height = `${Math.max(CAPSULE_MIN_H, Math.min(CAPSULE_MAX_H, computed)).toFixed(1)}px`;
  });

  // 2. Animate mini-pill wave bars (5 bars)
  const pillBars = document.querySelectorAll('#pillWaveform .wave-bar');
  pillBars.forEach((bar, idx) => {
    const e = pillHistory[idx] || 0;
    if (e <= 0.01) {
      bar.style.height = `${PILL_MIN_H}px`;
      return;
    }
    const wave = 1 + OSC_AMP * Math.sin((now / 1000) * 2 * Math.PI * OSC_FREQ + idx * PHASE_OFFSET);
    const range = (PILL_MAX_H - PILL_MIN_H) * 0.95;
    const computed = PILL_MIN_H + range * e * wave * PILL_PROFILE[idx];
    bar.style.height = `${Math.max(PILL_MIN_H, Math.min(PILL_MAX_H, computed)).toFixed(1)}px`;
  });

  // 3. Animate dictation capsule wave bars (6 bars)
  const dictBars = document.querySelectorAll('#dictWaveform .wave-bar');
  if (dictBars.length) {
    dictBars.forEach((bar, idx) => {
      const e = capsuleHistory[idx % CAPSULE_BARS] || 0;
      if (e <= 0.01) {
        bar.style.height = '4px';
        return;
      }
      const wave = 1 + OSC_AMP * Math.sin((now / 1000) * 2 * Math.PI * OSC_FREQ + idx * PHASE_OFFSET);
      const computed = 4 + 12 * e * wave * (CAPSULE_PROFILE[idx % CAPSULE_BARS] || 0.8);
      bar.style.height = `${Math.max(4, Math.min(18, computed)).toFixed(1)}px`;
    });
  }

  requestAnimationFrame(tickWaveform);
}
requestAnimationFrame(tickWaveform);

// ─── Hạng mục 1: Mini Pill Mode Toggle ────────────────────────────
function applyPillMode(pill) {
  isPill = Boolean(pill);
  localStorage.setItem('tina.overlay.is_pill', String(isPill));
  const recordEl = $('record');
  if (recordEl) {
    recordEl.classList.toggle('is-pill', isPill);
  }
}
applyPillMode(isPill);

// ─── Hạng mục 2: Result Toast Controller with Pause-on-Hover ──────
function showResultToast() {
  setMode('result');
  const elapsedText = clock(lastKnownElapsedMs);
  const sourceText = lastKnownApps.length ? appLabel(lastKnownApps) : 'Mic & System Audio';
  
  $('result-meta').textContent = `${elapsedText} • ${sourceText}`;
  $('result-snippet').textContent = lastKnownSnippet 
    ? `"${lastKnownSnippet}"`
    : '"Meeting transcript saved. Ready for review and AI extraction."';

  // Reset copy button state
  const copyBtn = $('result-copy');
  if (copyBtn) copyBtn.classList.remove('copied');
  const copyLabel = $('copy-label');
  if (copyLabel) copyLabel.textContent = 'Copy Text';

  // Animate 6s countdown bar
  const fill = $('result-countdown-fill');
  fill.classList.remove('running');
  void fill.offsetWidth; // Force reflow
  fill.classList.add('running');

  resultRemainingMs = 6000;
  resultStartTime = Date.now();
  isResultHovered = false;

  if (resultTimeout) clearTimeout(resultTimeout);
  resultTimeout = setTimeout(dismissResult, resultRemainingMs);
}

function pauseResultCountdown() {
  if (mode !== 'result' || isResultHovered) return;
  isResultHovered = true;
  if (resultTimeout) {
    clearTimeout(resultTimeout);
    resultTimeout = null;
  }
  const elapsed = Date.now() - resultStartTime;
  resultRemainingMs = Math.max(500, resultRemainingMs - elapsed);
}

function resumeResultCountdown() {
  if (mode !== 'result' || !isResultHovered) return;
  isResultHovered = false;
  resultStartTime = Date.now();
  if (resultTimeout) clearTimeout(resultTimeout);
  resultTimeout = setTimeout(dismissResult, resultRemainingMs);
}

function dismissResult() {
  if (resultTimeout) {
    clearTimeout(resultTimeout);
    resultTimeout = null;
  }
  isResultHovered = false;
  if (mode === 'result') {
    setMode('hidden');
    // Notify Tauri if applicable
    invoke('overlay_action', { action: 'dismiss_result' }).catch(() => {});
  }
}

// ─── Mode Switching ───────────────────────────────────────────────
function setMode(next) {
  const resolved = MODES.includes(next) ? next : 'hidden';
  if (resolved === mode) return;
  mode = resolved;
  document.body.dataset.mode = mode;
  for (const id of MODES) {
    const el = $(id);
    if (el) el.hidden = id !== mode;
  }
}

// ─── UI Rendering ─────────────────────────────────────────────────
function render(state) {
  if (!state || typeof state !== 'object') return;

  // If we are currently showing the Result Toast, don't let background poll override it
  if (mode === 'result') return;

  const prevMode = mode;
  const nextMode = state.mode;

  // Detect transition from Recording/Ended to Hidden -> Trigger Result Toast
  if ((prevMode === 'record' || prevMode === 'ended') && nextMode === 'hidden' && lastKnownElapsedMs > 2000) {
    showResultToast();
    return;
  }

  // Also support direct state.mode === 'result' from Rust
  if (nextMode === 'result') {
    showResultToast();
    return;
  }

  setMode(nextMode);
  const apps = Array.isArray(state.apps) ? state.apps : [];

  if (state.source_mode && state.source_mode !== currentSourceMode) {
    applySourceMode(state.source_mode, false);
  }

  if (mode === 'detect') {
    const label = appLabel(apps);
    const visual = getAppVisual(label);
    const iconEl = $('detect-icon');
    if (iconEl) {
      iconEl.innerHTML = visual.svg;
      iconEl.style.background = visual.bg;
    }
    $('detect-title').textContent = 'Đang tham gia họp?';
    $('detect-copy').textContent = `${label} đang sử dụng micro. Bắt đầu ghi âm và ghi chú cuộc họp?`;
    $('detect-copy').removeAttribute('data-error');
    if (!detectInterval) {
      startDetectCountdown();
    }
  } else {
    if (detectInterval) {
      clearInterval(detectInterval);
      detectInterval = null;
    }
  }

  if (mode === 'record' || mode === 'ended') {
    const paused = Boolean(state.paused);
    lastKnownElapsedMs = Number(state.elapsed_ms) || 0;
    lastKnownApps = apps;
    if (state.caption) {
      lastKnownSnippet = String(state.caption);
    } else if (state.pending) {
      lastKnownSnippet = String(state.pending);
    }

    $('record-elapsed').textContent = clock(state.elapsed_ms);
    $('record-state').textContent = paused ? 'Paused' : state.elapsed_ms > 0 ? 'Recording' : 'Connecting…';
    $('record-state').dataset.paused = String(paused);
    $('live-dot').classList.toggle('paused', paused);
    $('pill-live-dot').classList.toggle('paused', paused);

    feedAudioLevel(state.level, paused || mode !== 'record');

    $('pause').dataset.action = paused ? 'resume' : 'pause';
    const pauseLabel = $('pause').querySelector('.btn-label');
    if (pauseLabel) pauseLabel.textContent = paused ? 'Resume' : 'Pause';

    $('captions').setAttribute('aria-pressed', String(Boolean(state.subtitles)));
    const error = typeof state.error === 'string' ? state.error : '';
    $('record-error').hidden = !error;
    $('record-error').textContent = error;
  }

  if (mode === 'ended') {
    $('ended-copy').textContent = `${appLabel(apps)} released microphone. Still recording.`;
    const remaining = Math.max(0, Math.min(15000, Number(state.grace_remaining_ms) || 0));
    const seconds = Math.ceil(remaining / 1000);
    const grace = $('grace-copy');
    grace.removeAttribute('data-error');
    grace.textContent = remaining > 0
      ? `Auto-stops in ${seconds}s unless continued.`
      : 'Choose stop or keep recording.';
    $('grace-fill').style.transform = `scaleX(${(remaining / 15000).toFixed(3)})`;
  }

  if (mode === 'dictation') {
    feedAudioLevel(state.level, false);
    const dictText = $('dict-state-text');
    if (dictText) {
      dictText.textContent = state.level > 0.04 ? 'Listening…' : 'Dictating…';
    }
  }
}

async function poll() {
  try {
    render(await invoke('overlay_state'));
  } catch {}
}

async function act(action, button) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;

  try {
    if (action === 'stop') {
      // Trigger Result Toast immediately on stop click
      if (lastKnownElapsedMs > 1000) {
        showResultToast();
      }
    }
    await invoke('overlay_action', { action });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'record') {
      $('record-error').hidden = false;
      $('record-error').textContent = message;
    } else if (mode === 'ended') {
      const grace = $('grace-copy');
      grace.dataset.error = 'true';
      grace.textContent = message;
    } else {
      $('detect-copy').textContent = message;
      $('detect-copy').dataset.error = 'true';
    }
  } finally {
    if (button) button.disabled = false;
    busy = false;
    if (mode !== 'result') {
      await poll();
    }
  }
}

// ─── Hạng mục 3: Audio Source Selector Controller ─────────────────
const SOURCE_MODES = {
  both: { label: 'Both', qaLabel: 'Src: Both', action: 'source_both' },
  mic: { label: 'Mic', qaLabel: 'Src: Mic', action: 'source_mic' },
  system: { label: 'System', qaLabel: 'Src: Sys', action: 'source_system' },
};
let currentSourceMode = localStorage.getItem('tina.capture.source_mode') || 'both';

function applySourceMode(nextMode, triggerIpc = true) {
  if (!SOURCE_MODES[nextMode]) nextMode = 'both';
  currentSourceMode = nextMode;
  localStorage.setItem('tina.capture.source_mode', currentSourceMode);

  // Update Capsule source button label
  const labelEl = $('source-label');
  if (labelEl) labelEl.textContent = SOURCE_MODES[currentSourceMode].label;

  // Update Mini Pill quick action label
  const qaLabelEl = $('qa-source-label');
  if (qaLabelEl) qaLabelEl.textContent = SOURCE_MODES[currentSourceMode].qaLabel;

  // Update active state in dropdown
  document.querySelectorAll('.source-opt').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.sourceSet === currentSourceMode);
  });

  // Notify backend if requested
  if (triggerIpc) {
    invoke('overlay_action', { action: SOURCE_MODES[currentSourceMode].action }).catch(() => {});
  }
}
applySourceMode(currentSourceMode, false);

function toggleSourceDropdown(force) {
  const dd = $('sourceDropdown');
  const wrap = $('sourceSelectorWrap');
  if (!dd) return;
  const shouldOpen = typeof force === 'boolean' ? force : dd.hidden;
  dd.hidden = !shouldOpen;
  if (wrap) wrap.classList.toggle('open', shouldOpen);
}

function cycleAudioSource() {
  const modes = ['both', 'mic', 'system'];
  const nextIdx = (modes.indexOf(currentSourceMode) + 1) % modes.length;
  applySourceMode(modes[nextIdx], true);
}

// ─── Event Handlers ───────────────────────────────────────────────
document.addEventListener('click', (event) => {
  // Toggle Source Dropdown
  if (event.target.closest('#source-toggle-btn')) {
    event.stopPropagation();
    toggleSourceDropdown();
    return;
  }

  // Select Option from Dropdown
  const sourceOpt = event.target.closest('.source-opt');
  if (sourceOpt && sourceOpt.dataset.sourceSet) {
    applySourceMode(sourceOpt.dataset.sourceSet, true);
    toggleSourceDropdown(false);
    return;
  }

  // Cycle source in Mini Pill
  if (event.target.closest('#qa-source')) {
    cycleAudioSource();
    return;
  }

  // Click outside to close source dropdown
  if (!event.target.closest('#sourceSelectorWrap')) {
    toggleSourceDropdown(false);
  }
  // Mini pill toggle buttons
  if (event.target.closest('#btn-collapse')) {
    applyPillMode(true);
    return;
  }
  if (event.target.closest('#qa-expand')) {
    applyPillMode(false);
    return;
  }

  // Result Toast dismiss
  if (event.target.closest('#result-close')) {
    dismissResult();
    return;
  }

  // Result Copy button with Speakly-style auto-dismiss on copy
  if (event.target.closest('#result-copy')) {
    const textToCopy = lastKnownSnippet || 'Meeting transcript saved to TINA';
    navigator.clipboard?.writeText(textToCopy).then(() => {
      const btn = $('result-copy');
      const label = $('copy-label');
      if (btn) btn.classList.add('copied');
      if (label) label.textContent = 'Copied! ✓';
      setTimeout(() => {
        dismissResult();
      }, 700);
    });
    return;
  }

  // Result Open Notes button
  if (event.target.closest('#result-open')) {
    dismissResult();
    void invoke('overlay_action', { action: 'open' });
    return;
  }

  const button = event.target.closest('button[data-action]');
  if (button) void act(button.dataset.action, button);
});

// Double click pill body to expand back to full bar
$('pillBody')?.addEventListener('dblclick', () => {
  applyPillMode(false);
});

// Hover pause/resume on Result Toast
$('result')?.addEventListener('mouseenter', () => {
  pauseResultCountdown();
});
$('result')?.addEventListener('mouseleave', () => {
  resumeResultCountdown();
});

// Hover pause/resume on Meeting Detect Prompt
$('detect')?.addEventListener('mouseenter', () => {
  isDetectHovered = true;
});
$('detect')?.addEventListener('mouseleave', () => {
  isDetectHovered = false;
});

let looping = false;
async function loop() {
  if (looping) return;
  looping = true;
  await poll();
  looping = false;
  if (!document.hidden) timer = window.setTimeout(loop, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  window.clearTimeout(timer);
  if (!document.hidden) void loop();
});

for (const id of MODES) {
  const el = $(id);
  if (el) el.hidden = true;
}
void loop();
