import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, ADPCM_FRAME_BYTES, PCM_FRAME_BYTES } from '../src/services/adpcm.js';

function frame(fn) {
  const bytes = new Uint8Array(PCM_FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 320; i++) view.setInt16(i * 2, fn(i), true);
  return bytes;
}
const samples = (bytes) => { const v = new DataView(bytes.buffer); return Array.from({ length: 320 }, (_, i) => v.getInt16(i * 2, true)); };
const snr = (a, b) => {
  let signal = 0, noise = 0;
  for (let i = 0; i < a.length; i++) { signal += a[i] ** 2; noise += (a[i] - b[i]) ** 2; }
  return 10 * Math.log10(signal / Math.max(noise, 1));
};

test('frames shrink about 4:1', () => {
  assert.equal(ADPCM_FRAME_BYTES, 163);
  assert.equal(encodeFrame(frame(() => 0)).length, 163);
});

test('speech-band tones survive with usable signal-to-noise ratio', () => {
  for (const hz of [200, 440, 1000, 3000]) {
    const original = frame((i) => Math.round(9000 * Math.sin(2 * Math.PI * hz * i / 16000)));
    const carry = { index: 0 };
    for (let w = 0; w < 5; w++) encodeFrame(original, carry); // steady-state stream
    const decoded = decodeFrame(encodeFrame(original, carry));
    const db = snr(samples(original), samples(decoded));
    assert.ok(db > 15, `${hz} Hz SNR too low: ${db.toFixed(1)} dB`);
  }
});

test('silence stays silent and extremes do not overflow', () => {
  assert.ok(samples(decodeFrame(encodeFrame(frame(() => 0)))).every((v) => Math.abs(v) <= 8));
  const loud = frame((i) => (i % 2 ? 32767 : -32768));
  const decoded = samples(decodeFrame(encodeFrame(loud)));
  assert.ok(decoded.every((v) => v >= -32768 && v <= 32767));
});

test('every frame decodes on its own, so a lost frame cannot corrupt the next', () => {
  const a = encodeFrame(frame((i) => Math.round(7000 * Math.sin(i / 5))));
  const b = encodeFrame(frame((i) => Math.round(5000 * Math.sin(i / 9))));
  assert.deepEqual(decodeFrame(b), decodeFrame(new Uint8Array(b)));
  assert.ok(decodeFrame(a).length === 640);
});

test('wrong sizes and corrupt headers are rejected', () => {
  assert.throws(() => encodeFrame(new Uint8Array(10)), /size/);
  assert.throws(() => decodeFrame(new Uint8Array(10)), /size/);
  const bad = new Uint8Array(ADPCM_FRAME_BYTES); bad[2] = 200;
  assert.throws(() => decodeFrame(bad), /Invalid/);
});
