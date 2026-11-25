// Thin wrapper over the native Android MeshAudio plugin (AudioRecord/AudioTrack).
// 16 kHz, mono, signed 16-bit PCM, 20 ms frames (640 bytes), sent as base64.

export class AudioEngine {
  constructor() {
    this.handles = [];
    this.running = false;
  }

  getNative() {
    return globalThis.Capacitor?.Plugins?.MeshAudio || null;
  }

  isAvailable() {
    return Boolean(this.getNative());
  }

  async ensurePermission() {
    const native = this.getNative();
    if (!native) throw new Error('Voice calls require the installed Android app.');
    const result = await native.requestMicrophone();
    if (!result?.granted) throw new Error('Microphone permission is required for voice calls.');
  }

  async start({ onFrame, onError } = {}) {
    const native = this.getNative();
    if (!native) throw new Error('Voice calls require the installed Android app.');
    await this.removeListeners();
    this.handles.push(await native.addListener('onAudioFrame', (event) => {
      if (typeof event?.pcm === 'string') onFrame?.(event.pcm);
    }));
    this.handles.push(await native.addListener('onAudioError', (event) => {
      onError?.(new Error(event?.message || 'Audio error'));
    }));
    await native.start();
    this.running = true;
  }

  async play(pcm) {
    if (!this.running) return;
    await this.getNative()?.play({ pcm });
  }

  async setMuted(muted) {
    await this.getNative()?.setMuted({ muted });
  }

  async setSpeaker(speaker) {
    await this.getNative()?.setSpeaker({ speaker });
  }

  async stop() {
    this.running = false;
    await this.removeListeners();
    await this.getNative()?.stop();
  }

  async removeListeners() {
    for (const handle of this.handles) {
      try { await handle.remove(); } catch { /* already removed */ }
    }
    this.handles = [];
  }
}
