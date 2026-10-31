import assert from 'node:assert/strict';
import { isArchiveOnlyCaptureSource } from './audio-routing.js';

assert.equal(isArchiveOnlyCaptureSource(1002), true);
assert.equal(isArchiveOnlyCaptureSource(999), false);
assert.equal(isArchiveOnlyCaptureSource(1000), false);
assert.equal(isArchiveOnlyCaptureSource(3), false);
console.log('desktop audio routing: only the AEC raw-mic sidecar is archive-only');
