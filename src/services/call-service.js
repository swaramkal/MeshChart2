// Offline voice-call signalling and media pump.
//
// Signalling and audio frames travel as payloads inside the existing
// authenticated AES-GCM secure channel (sealPayload/openPacket), so no second
// encryption scheme exists. Calls are allowed only over Wi-Fi Direct: BLE GATT
// cannot carry continuous voice. Audio capture/playback is delegated to an
// injected audio engine (the native MeshAudio plugin on Android).

import { encodeFrame, decodeFrame, bytesToBase64, base64ToBytes, ADPCM_FRAME_BYTES } from './adpcm.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_PCM_BASE64 = 1400;          // one 20 ms 16 kHz PCM16 frame is ~856 chars
const MAX_IN_FLIGHT_FRAMES = 6;       // drop outgoing frames instead of queueing latency
const MAX_CONSECUTIVE_SEND_FAILURES = 25;

export const CALL_KINDS = ['call-invite', 'call-accept', 'call-reject', 'call-end', 'call-audio'];

function randomId() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return 'call_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class CallService {
  constructor({
    send,
    audio,
    getTransport,
    ringTimeoutMs = 30_000,
    silenceTimeoutMs = 8_000,
    idFactory = randomId,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t)
  } = {}) {
    if (typeof send !== 'function' || !audio || typeof getTransport !== 'function') {
      throw new Error('CallService needs send, audio and getTransport.');
    }
    this.send = send;
    this.audio = audio;
    this.getTransport = getTransport;
    this.ringTimeoutMs = ringTimeoutMs;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.idFactory = idFactory;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.clearTimers();
    this.call = null;
    this.snapshot = { state: 'idle', muted: false };
  }

  clearTimers() {
    if (this.ringTimer) this.clearTimer(this.ringTimer);
    if (this.silenceTimer) this.clearTimer(this.silenceTimer);
    this.ringTimer = null;
    this.silenceTimer = null;
  }

  onState(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getState() {
    return { ...this.snapshot };
  }

  emit(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const callback of this.listeners) {
      try { callback(this.getState()); } catch { /* listener errors never break a call */ }
    }
  }

  requireWifiDirect(peerId) {
    if (this.getTransport(peerId) !== 'wifi-direct') {
      throw new Error('Voice calls need a Wi-Fi Direct connection. Bluetooth LE cannot carry live audio.');
    }
  }

  async startCall(peerId, peerName = 'Nearby device') {
    if (this.call) throw new Error('A call is already in progress.');
    this.requireWifiDirect(peerId);
    await this.audio.ensurePermission();

    const callId = this.idFactory();
    this.call = {
      id: callId, peerId, direction: 'outgoing', nextSeq: 1, lastSeq: 0,
      inFlight: 0, failures: 0, muted: false, codecState: { index: 0 }
    };
    this.emit({ state: 'outgoing', peerId, peerName, callId, direction: 'outgoing', muted: false, reason: null, startedAt: null });

    try {
      await this.send(peerId, { kind: 'call-invite', callId });
    } catch (error) {
      this.finish('failed');
      throw new Error('Could not reach the other device. Check the Wi-Fi Direct connection.');
    }
    this.ringTimer = this.setTimer(() => this.end('no-answer'), this.ringTimeoutMs);
    return callId;
  }

  async accept() {
    const call = this.call;
    if (!call || call.direction !== 'incoming' || this.snapshot.state !== 'incoming') return false;
    try {
      this.requireWifiDirect(call.peerId);
      await this.audio.ensurePermission();
    } catch (error) {
      await this.reject('error');
      throw error;
    }
    try {
      await this.send(call.peerId, { kind: 'call-accept', callId: call.id });
    } catch {
      this.finish('connection-lost');
      return false;
    }
    return this.beginMedia();
  }

  async reject(reason = 'declined') {
    const call = this.call;
    if (!call || call.direction !== 'incoming' || this.snapshot.state !== 'incoming') return;
    const peerId = call.peerId;
    const id = call.id;
    this.finish(reason);
    await this.send(peerId, { kind: 'call-reject', callId: id, reason }).catch(() => {});
  }

  async end(reason = 'ended') {
    const call = this.call;
    if (!call) return;
    const { peerId, id } = call;
    this.finish(reason);
    await this.send(peerId, { kind: 'call-end', callId: id, reason }).catch(() => {});
  }

  async setMuted(muted) {
    if (!this.call) return;
    this.call.muted = Boolean(muted);
    await this.audio.setMuted(Boolean(muted)).catch(() => {});
    this.emit({ muted: Boolean(muted) });
  }

  async setSpeaker(on) {
    await this.audio.setSpeaker(Boolean(on)).catch(() => {});
    this.emit({ speaker: Boolean(on) });
  }

  async beginMedia() {
    const call = this.call;
    if (!call) return false;
    try {
      await this.audio.start({
        onFrame: (pcm) => this.sendFrame(pcm),
        onError: () => this.end('audio-error')
      });
    } catch (error) {
      await this.end('audio-error');
      return false;
    }
    this.clearTimers();
    this.emit({ state: 'active', startedAt: Date.now(), reason: null });
    this.armSilenceWatchdog();
    return true;
  }

  armSilenceWatchdog() {
    if (this.silenceTimer) this.clearTimer(this.silenceTimer);
    this.silenceTimer = this.setTimer(() => this.end('connection-lost'), this.silenceTimeoutMs);
  }

  sendFrame(pcm) {
    const call = this.call;
    if (!call || this.snapshot.state !== 'active' || call.muted) return;
    if (this.getTransport(call.peerId) !== 'wifi-direct') {
      // Never push live audio over Bluetooth LE if Wi-Fi Direct dropped.
      call.failures++;
      if (call.failures >= MAX_CONSECUTIVE_SEND_FAILURES) this.finish('connection-lost');
      return;
    }
    if (call.inFlight >= MAX_IN_FLIGHT_FRAMES) return; // drop rather than build delay
    call.inFlight++;
    let packed;
    try {
      packed = bytesToBase64(encodeFrame(base64ToBytes(pcm), call.codecState));
    } catch { return; } // malformed capture frame: drop it
    const seq = call.nextSeq++;
    this.send(call.peerId, { kind: 'call-audio', callId: call.id, seq, codec: 'adpcm', pcm: packed })
      .then(() => { if (this.call === call) call.failures = 0; })
      .catch(() => {
        if (this.call !== call) return;
        call.failures++;
        if (call.failures >= MAX_CONSECUTIVE_SEND_FAILURES) this.finish('connection-lost');
      })
      .finally(() => { call.inFlight--; });
  }

  // Called when a transport reports the peer is gone.
  handlePeerDisconnect(peerId) {
    if (this.call && this.call.peerId === peerId) this.finish('connection-lost');
  }

  // Entry point for decrypted, authenticated payloads. Returns true if handled.
  async handleSignal(peerId, payload, peerName) {
    if (!payload || !CALL_KINDS.includes(payload.kind)) return false;
    if (typeof payload.callId !== 'string' || !ID_PATTERN.test(payload.callId)) return true;

    if (payload.kind === 'call-invite') {
      if (this.call || this.getTransport(peerId) !== 'wifi-direct') {
        await this.send(peerId, { kind: 'call-reject', callId: payload.callId, reason: this.call ? 'busy' : 'transport' }).catch(() => {});
        return true;
      }
      this.call = {
        id: payload.callId, peerId, direction: 'incoming', nextSeq: 1, lastSeq: 0,
        inFlight: 0, failures: 0, muted: false, codecState: { index: 0 }
      };
      this.emit({ state: 'incoming', peerId, peerName: peerName || 'Nearby device', callId: payload.callId, direction: 'incoming', muted: false, reason: null, startedAt: null });
      this.ringTimer = this.setTimer(() => this.reject('missed'), this.ringTimeoutMs);
      return true;
    }

    const call = this.call;
    if (!call || call.id !== payload.callId || call.peerId !== peerId) return true; // stale or foreign call

    switch (payload.kind) {
      case 'call-accept':
        if (call.direction === 'outgoing' && this.snapshot.state === 'outgoing') await this.beginMedia();
        break;
      case 'call-reject':
        if (call.direction === 'outgoing') this.finish(payload.reason === 'busy' ? 'busy' : 'declined');
        break;
      case 'call-end':
        this.finish('remote-ended');
        break;
      case 'call-audio':
        await this.receiveAudio(call, payload);
        break;
    }
    return true;
  }

  async receiveAudio(call, payload) {
    if (this.snapshot.state !== 'active') return;
    if (!Number.isSafeInteger(payload.seq) || payload.seq <= call.lastSeq) return; // stale / replayed / reordered
    if (typeof payload.pcm !== 'string' || payload.pcm.length < 4 || payload.pcm.length > MAX_PCM_BASE64 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.pcm)) return;
    if (payload.codec !== 'adpcm') return; // only the compressed format is accepted
    let frame;
    try {
      const packed = base64ToBytes(payload.pcm);
      if (packed.length !== ADPCM_FRAME_BYTES) return;
      frame = bytesToBase64(decodeFrame(packed));
    } catch { return; }
    call.lastSeq = payload.seq;
    this.armSilenceWatchdog();
    try { await this.audio.play(frame); } catch { /* a dropped frame is acceptable */ }
  }

  finish(reason) {
    const wasActive = this.call !== null;
    this.clearTimers();
    this.call = null;
    this.audio.stop().catch(() => {});
    if (wasActive) this.emit({ state: 'ended', reason, muted: false });
    this.snapshot = { ...this.snapshot, state: 'idle' };
    // keep last reason available to UI via the 'ended' emission above
  }
}
