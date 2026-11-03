// Runs INSIDE an isolated existing bot image via BOT_WORKER_ENTRY. No meeting is joined.
// Exercises the shipped adapter + real TTS + PulseAudio, including Stop during playback.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createTtsPlayback } from '/app/core/meetings/services/bot/dist/tts-playback.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const muted = () => execFileSync('pactl', ['get-source-mute', 'virtual_mic'], { encoding: 'utf8' }).includes('yes');
const logs = [];
const playback = createTtsPlayback(message => logs.push(message));
const frames = [];
let recordedBytes = 0;
const recorder = spawn('parec', ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=virtual_mic'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
recorder.stdout.on('data', data => {
  recordedBytes += data.length;
  if (recordedBytes <= 24000 * 2 * 120) frames.push(data);
});

try {
  await sleep(300);
  const start = Date.now();
  await playback.speak('Xin chào, tôi là TINA. Đây là bài kiểm tra âm thanh tiếng Việt.');
  assert(muted(), 'source must be muted after completed playback');
  await sleep(200);
  recorder.kill('SIGTERM');
  await new Promise(resolve => recorder.once('exit', resolve));
  const pcm = Buffer.concat(frames);
  let active = 0, peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = Math.abs(pcm.readInt16LE(i));
    if (value > 200) active++;
    peak = Math.max(peak, value);
  }
  assert(active > 2400, 'virtual microphone must contain at least 100 ms of non-silent audio');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync('/tmp/tts-virtual-mic.wav', Buffer.concat([header, pcm]));

  const second = playback.speak('Đây là bài kiểm tra dừng giọng nói. '.repeat(4));
  const deadline = Date.now() + 28000;
  while (muted() && Date.now() < deadline) await sleep(40);
  assert(!muted(), 'second synthesis must reach actual playback before testing Stop');
  await sleep(250);
  const stopAt = Date.now();
  playback.stop();
  await Promise.race([second, sleep(2000).then(() => { throw new Error('Stop did not settle playback'); })]);
  assert(muted(), 'Stop must re-mute the virtual microphone');
  assert(!logs.some(line => /service (4|5)\d\d|paplay error|bad TTS_SERVICE_URL/.test(line)), 'playback adapter reported failure');
  const report = { full_playback: true, non_silent_samples: active, peak,
    stop_during_playback: true, stop_ms: Date.now() - stopAt,
    source_muted_after_stop: muted(), seconds: (Date.now() - start) / 1000 };
  writeFileSync('/tmp/tts-playback-proof.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  playback.stop();
  recorder.kill('SIGTERM');
}
