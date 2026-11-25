import test from 'node:test';
import assert from 'node:assert/strict';
import { CallService } from '../src/services/call-service.js';

import { encodeFrame, bytesToBase64 } from '../src/services/adpcm.js';

function sineFrame() {
  const bytes = new Uint8Array(640);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 320; i++) view.setInt16(i * 2, Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), true);
  return bytes;
}
const PCM = bytesToBase64(sineFrame());                 // what the microphone delivers
const PACKED = bytesToBase64(encodeFrame(sineFrame())); // what travels over the air

function makeAudio() {
  return {
    permission: true, startFails: false, started: 0, stopped: 0, played: [], muted: [], onFrame: null,
    async ensurePermission() { if (!this.permission) throw new Error('Microphone permission is required for voice calls.'); },
    async start({ onFrame }) { if (this.startFails) throw new Error('no mic'); this.started++; this.onFrame = onFrame; },
    async stop() { this.stopped++; },
    async play(pcm) { this.played.push(pcm); },
    async setMuted(m) { this.muted.push(m); },
    async setSpeaker() {}
  };
}

function makePair({ transport = 'wifi-direct' } = {}) {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { t.cleared = true; };
  const a = { audio: makeAudio(), sent: [], timers };
  const b = { audio: makeAudio(), sent: [], timers };
  let n = 0;
  const idFactory = () => `call_test_id_${String(++n).padStart(8, '0')}`;
  a.svc = new CallService({ audio: a.audio, getTransport: () => transport, idFactory, setTimer, clearTimer,
    send: async (peer, payload) => { a.sent.push(payload); await b.svc.handleSignal('A', payload, 'Alice'); } });
  b.svc = new CallService({ audio: b.audio, getTransport: () => transport, idFactory, setTimer, clearTimer,
    send: async (peer, payload) => { b.sent.push(payload); await a.svc.handleSignal('B', payload, 'Bob'); } });
  return { a, b, timers };
}

const flush = () => new Promise((r) => setImmediate(r));

test('full call: invite, accept, two-way audio, end', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B', 'Bob');
  assert.equal(a.svc.getState().state, 'outgoing');
  assert.equal(b.svc.getState().state, 'incoming');
  await b.svc.accept();
  assert.equal(a.svc.getState().state, 'active');
  assert.equal(b.svc.getState().state, 'active');

  a.audio.onFrame(PCM); b.audio.onFrame(PCM);
  await flush();
  assert.equal(b.audio.played.length, 1);
  assert.equal(a.audio.played.length, 1);
  assert.equal(Buffer.from(b.audio.played[0], 'base64').length, 640);
  assert.equal(a.sent.find((p) => p.kind === 'call-audio').codec, 'adpcm');
  assert.ok(a.sent.find((p) => p.kind === 'call-audio').pcm.length < 240, 'compressed frame should be ~220 chars');

  await a.svc.end();
  assert.equal(a.svc.getState().state, 'idle');
  assert.equal(b.svc.getState().state, 'idle');
  assert.ok(a.audio.stopped >= 1 && b.audio.stopped >= 1);
});

test('reject ends the outgoing call without starting audio', async () => {
  const { a, b } = makePair();
  const ended = [];
  a.svc.onState((s) => { if (s.state === 'ended') ended.push(s.reason); });
  await a.svc.startCall('B');
  await b.svc.reject();
  assert.deepEqual(ended, ['declined']);
  assert.equal(a.audio.started, 0);
  assert.equal(b.audio.started, 0);
});

test('calls are refused over Bluetooth', async () => {
  const { a } = makePair({ transport: 'bluetooth' });
  await assert.rejects(() => a.svc.startCall('B'), /Wi-Fi Direct/);
  assert.equal(a.svc.getState().state, 'idle');
});

test('incoming invite over Bluetooth is rejected automatically', async () => {
  const { b } = makePair({ transport: 'bluetooth' });
  const sent = [];
  b.svc.send = async (p, payload) => { sent.push(payload); };
  await b.svc.handleSignal('A', { kind: 'call-invite', callId: 'call_test_id_00000001' });
  assert.equal(b.svc.getState().state, 'idle');
  assert.equal(sent[0].kind, 'call-reject');
});

test('second invite while busy is rejected as busy', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  const sent = [];
  b.svc.send = async (p, payload) => { sent.push(payload); };
  await b.svc.handleSignal('C', { kind: 'call-invite', callId: 'call_other_id_000001' });
  assert.equal(sent[0].reason, 'busy');
  assert.equal(b.svc.getState().state, 'incoming');
});

test('microphone permission denied stops the call before signalling', async () => {
  const { a } = makePair();
  a.audio.permission = false;
  await assert.rejects(() => a.svc.startCall('B'), /Microphone/);
  assert.equal(a.sent.length, 0);
});

test('audio start failure ends the call on the failing side', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  b.audio.startFails = true;
  assert.equal(await b.svc.accept(), false);
  assert.equal(b.svc.getState().state, 'idle');
  assert.equal(a.svc.getState().state, 'idle');
});

test('mute stops outgoing audio frames', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  await b.svc.accept();
  await a.svc.setMuted(true);
  a.audio.onFrame(PCM);
  await flush();
  assert.equal(b.audio.played.length, 0);
  assert.deepEqual(a.audio.muted, [true]);
  await a.svc.setMuted(false);
  a.audio.onFrame(PCM);
  await flush();
  assert.equal(b.audio.played.length, 1);
});

test('stale, replayed, oversized and malformed audio frames are dropped', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  await b.svc.accept();
  const id = a.svc.getState().callId;
  const frame = (seq, pcm, codec = 'adpcm') => b.svc.handleSignal('A', { kind: 'call-audio', callId: id, seq, codec, pcm });
  await frame(5, PACKED);
  await frame(5, PACKED);       // replay
  await frame(3, PACKED);       // older
  await frame(8, PCM);          // raw PCM is no longer accepted
  await frame(9, PACKED, 'pcm16');
  await frame(10, PACKED.slice(0, 40));  // truncated
  await frame(6, 'x'.repeat(2000));
  await frame(7, '***not base64***');
  await frame(1.5, PACKED);
  await b.svc.handleSignal('A', { kind: 'call-audio', callId: 'call_wrong_id_0000001', seq: 9, codec: 'adpcm', pcm: PACKED });
  assert.equal(b.audio.played.length, 1);
});

test('signals from another peer or with invalid ids are ignored', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  const id = a.svc.getState().callId;
  await a.svc.handleSignal('EVIL', { kind: 'call-end', callId: id });
  assert.equal(a.svc.getState().state, 'outgoing');
  await a.svc.handleSignal('B', { kind: 'call-end', callId: '../bad' });
  assert.equal(a.svc.getState().state, 'outgoing');
  assert.equal(await a.svc.handleSignal('B', { kind: 'text' }), false);
});

test('unanswered outgoing call times out', async () => {
  const { a, timers } = makePair();
  const ended = [];
  a.svc.onState((s) => { if (s.state === 'ended') ended.push(s.reason); });
  a.svc.send = async () => {};
  await a.svc.startCall('B');
  timers.find((t) => !t.cleared && t.ms === 30_000).fn();
  await flush();
  assert.deepEqual(ended, ['no-answer']);
});

test('connection loss: silence watchdog and transport disconnect end the call', async () => {
  const { a, b, timers } = makePair();
  await a.svc.startCall('B');
  await b.svc.accept();
  const ended = [];
  b.svc.onState((s) => { if (s.state === 'ended') ended.push(s.reason); });
  timers.filter((t) => !t.cleared && t.ms === 8_000).at(-1).fn();
  await flush();
  assert.deepEqual(ended, ['connection-lost']);

  await a.svc.handlePeerDisconnect('B');
  assert.equal(a.svc.getState().state, 'idle');
});

test('repeated send failures end the call as connection-lost', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  await b.svc.accept();
  const ended = [];
  a.svc.onState((s) => { if (s.state === 'ended') ended.push(s.reason); });
  a.svc.send = async () => { throw new Error('socket closed'); };
  for (let i = 0; i < 40 && a.svc.getState().state === 'active'; i++) {
    a.audio.onFrame(PCM);
    await flush();
  }
  assert.deepEqual(ended, ['connection-lost']);
});

test('outgoing frames are dropped when the sender backs up', async () => {
  const { a, b } = makePair();
  await a.svc.startCall('B');
  await b.svc.accept();
  let pending = 0;
  a.svc.send = () => { pending++; return new Promise(() => {}); };
  for (let i = 0; i < 20; i++) a.audio.onFrame(PCM);
  assert.equal(pending, 6);
});

test('audio is dropped (not sent over BLE) when Wi-Fi Direct is no longer the active link', async () => {
  let transport = 'wifi-direct';
  const { a, b } = makePair();
  a.svc.getTransport = () => transport;
  await a.svc.startCall('B');
  await b.svc.accept();
  transport = 'bluetooth';
  const before = a.sent.length;
  a.audio.onFrame(PCM);
  await flush();
  assert.equal(a.sent.length, before);
});

test('a real audio frame fits the encrypted packet limit and round-trips through the secure channel', async () => {
  const { CryptoService } = await import('../src/services/crypto.js');
  const { sealPayload, openPacket } = await import('../src/services/secure-channel.js');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const base = { sessionId: 'b'.repeat(32), encryptionKey: key };
  const alice = { ...base, role: 'initiator' };
  const bob = { ...base, role: 'responder' };
  const service = new CryptoService();
  const packet = await sealPayload(service, alice, { kind: 'call-audio', callId: 'call_test_id_00000001', seq: 123456, codec: 'adpcm', pcm: PACKED });
  assert.ok(Buffer.byteLength(packet) < 2900);
  assert.ok(!packet.includes(PACKED), 'audio must not appear in plaintext');
  const payload = await openPacket(service, bob, packet);
  assert.equal(payload.pcm, PACKED);
  assert.ok(Buffer.byteLength(packet) < 700, `encrypted audio packet is ${Buffer.byteLength(packet)} bytes`);
  await assert.rejects(() => openPacket(service, bob, packet), /Replayed/);
});
