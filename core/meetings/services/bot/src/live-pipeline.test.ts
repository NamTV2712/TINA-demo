/**
 * L2 — createLivePipeline guard (#593 A4). The admitted→capture-start handoff had NO unit before
 * this: the composed pipeline was inline in index.ts (three bare awaits). This proves the
 * load-bearing invariant — a post-admission subsystem failure (page-side capture throw, recording
 * throw, or the engine/pyannote-model load rejecting) DEGRADES LOUDLY and NEVER rejects start(), so
 * the orchestrator's leave-on-pipeline-fail backstop never fires and the bot stays seated.
 *
 * RED on the pre-#593 inline pipeline (the first thrown await rejects start()); GREEN after.
 * Run: npx tsx src/live-pipeline.test.ts
 */
import { createBotPipeline, createLiveFaultReporter, createLivePipeline, serr, type LiveStage } from './pipeline.js';
import type { Invocation } from './config.js';
import type { Pipeline, TranscriptSink } from './ports.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

// A fake engine (the BotPipeline seen as a Pipeline) with a controllable start + start/stop counters.
const fakeEngine = (startImpl?: () => Promise<void>): Pipeline & { starts: number; stops: number } => {
  const e = {
    starts: 0, stops: 0,
    async start(): Promise<void> { e.starts++; if (startImpl) await startImpl(); },
    async stop(): Promise<void> { e.stops++; },
  };
  return e;
};

type Spy = { started: number; stopped: number };
const okThunk = (spy: Spy) => async (): Promise<() => Promise<void>> => { spy.started++; return async () => { spy.stopped++; }; };
const throwThunk = (e: unknown) => async (): Promise<() => Promise<void>> => { throw e; };

async function main(): Promise<void> {
  // A startup fault is retained for the lifecycle terminal event, not only printed to worker logs.
  {
    const faults = createLiveFaultReporter();
    check('pipeline fault report is absent before any stage fails', faults.report() === undefined);
    faults.record('capture-start');
    faults.record('engine-start');
    faults.record('capture-start');
    const report = faults.report();
    const stages = report?.pipeline_faults as Array<{ stage: LiveStage; count: number }> | undefined;
    check('pipeline fault report retains per-stage counts',
      stages?.length === 2
        && stages.some((fault) => fault.stage === 'capture-start' && fault.count === 2)
        && stages.some((fault) => fault.stage === 'engine-start' && fault.count === 1),
      JSON.stringify(stages));
    check('pipeline fault report explains degraded completion',
      report?.reason === 'pipeline_degraded: capture-start×2, engine-start×1', String(report?.reason));
  }

  // 1) capture-start throws a fabricated {isTrusted:true} DOM-like Event → start() RESOLVES; engine
  //    still starts; the fault is reported. This is the exact #593 self-evict class.
  {
    const faults: LiveStage[] = [];
    const engine = fakeEngine();
    let resolved = false;
    const live = createLivePipeline({
      startCapture: throwThunk({ isTrusted: true, type: 'error' }),   // the misdirecting event shape
      engine,
      onFault: (s) => faults.push(s),
      retry: { attempts: 1, delayMs: 0 },
    });
    await live.start().then(() => { resolved = true; });
    check('capture throw: start() RESOLVED (no self-evict)', resolved);
    check('capture throw: engine STILL started after the capture throw', engine.starts === 1);
    check('capture throw: onFault(capture-start) fired', faults.includes('capture-start'));
  }

  // 2) engine-start throws (the pyannote model-load reject) → start() RESOLVES; fault reported.
  {
    const faults: LiveStage[] = [];
    const capSpy: Spy = { started: 0, stopped: 0 };
    const engine = fakeEngine(async () => { throw new Error('from_pretrained: config.json not found'); });
    let resolved = false;
    const live = createLivePipeline({
      startCapture: okThunk(capSpy),
      engine,
      onFault: (s) => faults.push(s),
      retry: { attempts: 1, delayMs: 0 },
    });
    await live.start().then(() => { resolved = true; });
    check('engine throw: start() RESOLVED (bot stays seated)', resolved);
    check('engine throw: onFault(engine-start) fired', faults.includes('engine-start'));
    check('engine throw: capture attached first', capSpy.started === 1);
  }

  // 3) recording-start throws → start() RESOLVES; fault reported; engine still starts.
  {
    const faults: LiveStage[] = [];
    const capSpy: Spy = { started: 0, stopped: 0 };
    const engine = fakeEngine();
    let resolved = false;
    const live = createLivePipeline({
      startCapture: okThunk(capSpy),
      startRecording: throwThunk(new Error('MediaRecorder boom')),
      engine,
      onFault: (s) => faults.push(s),
      retry: { attempts: 1, delayMs: 0 },
    });
    await live.start().then(() => { resolved = true; });
    check('recording throw: start() RESOLVED', resolved);
    check('recording throw: onFault(recording-start) fired', faults.includes('recording-start'));
    check('recording throw: engine STILL started', engine.starts === 1);
  }

  // 4) happy path → no faults; stop() tears down capture + recording + engine.
  {
    const faults: LiveStage[] = [];
    const capSpy: Spy = { started: 0, stopped: 0 };
    const recSpy: Spy = { started: 0, stopped: 0 };
    const engine = fakeEngine();
    const live = createLivePipeline({
      startCapture: okThunk(capSpy), startRecording: okThunk(recSpy), engine, onFault: (s) => faults.push(s),
    });
    await live.start();
    check('happy: no faults', faults.length === 0, faults.join(','));
    check('happy: engine started', engine.starts === 1);
    await live.stop();
    check('happy: stop tore down capture', capSpy.stopped === 1);
    check('happy: stop tore down recording', recSpy.stopped === 1);
    check('happy: stop stopped engine', engine.stops === 1);
  }

  // Stop during a pending capture attach must not start later stages, and a late
  // teardown handle must be invoked instead of being stored after stop has drained.
  {
    let captureEnteredResolve!: () => void;
    const captureEntered = new Promise<void>((resolve) => { captureEnteredResolve = resolve; });
    let releaseCapture!: (stop: () => Promise<void>) => void;
    const pendingCapture = new Promise<() => Promise<void>>((resolve) => { releaseCapture = resolve; });
    let captureStops = 0;
    let recordingStarts = 0;
    const engine = fakeEngine();
    const live = createLivePipeline({
      startCapture: () => { captureEnteredResolve(); return pendingCapture; },
      startRecording: async () => {
        recordingStarts++;
        return async () => {};
      },
      engine,
      onFault: () => {},
    });
    const starting = live.start();
    await captureEntered;
    await live.stop();
    releaseCapture(async () => { captureStops++; });
    await starting;
    check('stop during capture start: late capture handle is torn down', captureStops === 1);
    check('stop during capture start: recording and engine do not start later',
      recordingStarts === 0 && engine.starts === 0);
  }

  // 5) engine retry: fails once then succeeds → self-heals in the background without evicting.
  {
    let attempts = 0;
    let runRetry: (() => void) | null = null;
    let secondAttemptResolve!: () => void;
    const secondAttempt = new Promise<void>((resolve) => { secondAttemptResolve = resolve; });
    const engine = fakeEngine(async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient model load');
      secondAttemptResolve();
    });
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }),
      engine,
      onFault: () => {},
      retry: { attempts: 3, delayMs: 5 },
      scheduleRetry(callback) {
        runRetry = callback;
        return { cancel() { runRetry = null; } };
      },
    });
    await live.start();
    check('retry: start() resolved despite first-attempt failure', true);
    const retry = runRetry;
    check('retry: a retry is scheduled after the first engine fault', retry !== null);
    retry?.();
    await secondAttempt;
    check('retry: engine eventually started (self-heal)', attempts === 2, `attempts=${attempts}`);
    await live.stop();
  }

  // 6) stop() cancels a pending retry timer — no leaked timer, no post-stop start attempts.
  {
    let attempts = 0;
    let retryCallback: (() => void) | null = null;
    let cancellations = 0;
    const engine = fakeEngine(async () => { attempts++; throw new Error('always fails'); });
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }),
      engine,
      onFault: () => {},
      retry: { attempts: 5, delayMs: 5 },
      scheduleRetry(callback) {
        retryCallback = callback;
        return { cancel() { cancellations++; } };
      },
    });
    await live.start();
    const pendingRetry = retryCallback;
    await live.stop();
    pendingRetry?.(); // model a timer callback already queued when stop cancelled it
    check('stop: pending retry is cancelled and a late timer callback cannot restart the engine',
      cancellations === 1 && attempts === 1, `cancellations=${cancellations}, attempts=${attempts}`);
  }

  // 7) stop is bounded while an in-flight background retry is unresolved.
  {
    const events: string[] = [];
    let secondAttemptStartedResolve!: () => void;
    const secondAttemptStarted = new Promise<void>((resolve) => { secondAttemptStartedResolve = resolve; });
    let releaseSecondAttempt!: () => void;
    const secondAttemptGate = new Promise<void>((resolve) => { releaseSecondAttempt = resolve; });
    let lateStopResolve!: () => void;
    const lateStop = new Promise<void>((resolve) => { lateStopResolve = resolve; });
    let attempts = 0;
    const engine: Pipeline = {
      async start() {
        attempts++;
        events.push(`engine-start-${attempts}`);
        if (attempts === 1) throw new Error('transient model load');
        secondAttemptStartedResolve();
        await secondAttemptGate;
        events.push('engine-start-2-settled');
      },
      async stop() {
        events.push('engine-stop');
        if (events.includes('engine-start-2-settled')) lateStopResolve();
      },
    };
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }),
      engine,
      onFault: () => {},
      onStopDuringEngineStart() { events.push('stop-during-engine-start'); },
      retry: { attempts: 3, delayMs: 0 },
    });

    await live.start();
    await secondAttemptStarted;
    const stopping = live.stop();
    let stopTimeout: ReturnType<typeof setTimeout> | undefined;
    const stoppedBeforeRelease = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => { stopTimeout = setTimeout(() => resolve(false), 1_000); }),
    ]);
    if (stopTimeout) clearTimeout(stopTimeout);
    check('stop: in-flight engine startup cannot hold shutdown open', stoppedBeforeRelease, JSON.stringify(events));
    check('stop: engine teardown begins before the startup attempt settles',
      events.includes('stop-during-engine-start') && events.includes('engine-stop'), JSON.stringify(events));
    releaseSecondAttempt();
    let lateStopTimeout: ReturnType<typeof setTimeout> | undefined;
    const lateStopObserved = await Promise.race([
      lateStop.then(() => true),
      new Promise<boolean>((resolve) => { lateStopTimeout = setTimeout(() => resolve(false), 1_000); }),
    ]);
    if (lateStopTimeout) clearTimeout(lateStopTimeout);
    await stopping;
    check('stop: a late successful startup is stopped again after it settles',
      lateStopObserved
        && events.indexOf('engine-start-2-settled') !== -1
        && events.lastIndexOf('engine-stop') > events.indexOf('engine-start-2-settled'),
      JSON.stringify(events));
  }

  // 8) retry exhaustion is reported immediately with the configured attempt count.
  {
    let attempts = 0;
    let failedAttempts = 0;
    let lastFailureResolve!: () => void;
    const lastFailure = new Promise<void>((resolve) => { lastFailureResolve = resolve; });
    let reported: { attempts: number; maxAttempts: number } | undefined;
    const engine = fakeEngine(async () => {
      attempts++;
      throw new Error('engine unavailable');
    });
    const live = createLivePipeline({
      startCapture: okThunk({ started: 0, stopped: 0 }),
      engine,
      onFault: () => {
        failedAttempts++;
        if (failedAttempts === 2) lastFailureResolve();
      },
      onRetriesExhausted: (count, maxAttempts) => { reported = { attempts: count, maxAttempts }; },
      retry: { attempts: 2, delayMs: 0 },
    });

    await live.start();
    await lastFailure;
    check('retry exhaustion: reports attempts and configured maximum immediately',
      attempts === 2 && reported?.attempts === 2 && reported.maxAttempts === 2,
      `${attempts}/${JSON.stringify(reported)}`);
    await live.stop();
  }

  // 9) the bot pipeline waits for queued transcript writes before stop resolves.
  {
    let flushStartedResolve!: () => void;
    const flushStarted = new Promise<void>((resolve) => { flushStartedResolve = resolve; });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const sink: TranscriptSink = {
      async publish() {},
      async retract() {},
      flush() {
        flushStartedResolve();
        return flushGate;
      },
    };
    const inv: Invocation = {
      platform: 'google_meet',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      botName: 'TINA',
      redisUrl: 'redis://localhost:6379',
      transcribeEnabled: false,
    };
    const pipeline = createBotPipeline(inv, sink);
    await pipeline.start();
    let stopResolved = false;
    const stopping = pipeline.stop().then(() => { stopResolved = true; });
    const flushCalled = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 2_000);
      void flushStarted.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    check('pipeline stop: waits for transcript egress flush', flushCalled && !stopResolved);
    releaseFlush();
    await stopping;
    check('pipeline stop: resolves after accepted writes settle', stopResolved);
  }

  // 10) serr: full-fidelity serialization — the A1 fix for the {isTrusted:true} fidelity loss.
  {
    const e = new Error('config.json not found');
    check('serr: Error → includes message', serr(e).includes('config.json not found'));
    check('serr: Error → includes a stack frame', /\bat\b/.test(serr(e)));
    check('serr: bare object → NOT flattened to [object …]', !serr({ isTrusted: true }).includes('[object'));
  }

  console.log(failed === 0 ? '\n✅ live-pipeline: all passed' : `\n❌ live-pipeline: ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
