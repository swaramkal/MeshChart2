const ACK_TIMEOUT_MS = 5000;

export class RelayTransportBridge {
  constructor({ relay, getPeers, sendEnvelope, ackTimeoutMs = ACK_TIMEOUT_MS } = {}) {
    if (!relay || typeof getPeers !== 'function' || typeof sendEnvelope !== 'function') {
      throw new Error('Relay, peer lookup, and envelope sender are required.');
    }
    this.relay = relay;
    this.getPeers = getPeers;
    this.sendEnvelope = sendEnvelope;
    this.ackTimeoutMs = ackTimeoutMs;
    this.inFlight = new Map();
    this.attemptedPeers = new Map();
    this.retryTimers = new Map();
    this.forwarding = null;
  }

  async receive(envelope, fromPeerId, now = Date.now()) {
    const result = await this.relay.receive(envelope, now, fromPeerId);
    if (result.accepted) await this.forward(now);
    return result;
  }

  async forward(now = Date.now()) {
    if (!this.relay.enabled) return { sent: 0, queued: (await this.relay.getQueueStatus(now)).queued };
    if (this.forwarding) return this.forwarding;
    this.forwarding = this.forwardQueued(now).finally(() => { this.forwarding = null; });
    return this.forwarding;
  }

  async forwardQueued(now) {
    const packets = await this.relay.db.getRelayPackets();
    let sent = 0;
    for (const packet of packets) {
      if (this.inFlight.has(packet.id)) continue;
      const envelope = await this.relay.prepareForward(packet.id, now);
      if (!envelope) continue;

      const attempted = this.attemptedPeers.get(packet.id) || new Set();
      const source = packet.receivedFrom ? String(packet.receivedFrom) : null;
      const candidates = this.uniquePeers(this.getPeers())
        .filter((peer) => peer.connected && peer.id !== source && !attempted.has(peer.id));
      const candidate = candidates[0];
      if (!candidate) {
        if (attempted.size) this.scheduleRetry(packet.id, attempted, candidates.length);
        continue;
      }

      this.inFlight.set(packet.id, { peerId: candidate.id });
      attempted.add(candidate.id);
      this.attemptedPeers.set(packet.id, attempted);
      try {
        await this.sendEnvelope(candidate.id, envelope);
        if (this.inFlight.get(packet.id)?.peerId === candidate.id) {
          this.scheduleRetry(packet.id, attempted, candidates.length);
        }
        sent++;
      } catch {
        this.inFlight.delete(packet.id);
        this.scheduleRetry(packet.id, attempted);
      }
    }
    return { sent, queued: (await this.relay.getQueueStatus(now)).queued };
  }

  uniquePeers(peers) {
    const seen = new Set();
    return peers.filter((peer) => {
      const fingerprint = peer.fingerprint || peer.identityFingerprintHint || peer.id;
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  }

  scheduleRetry(messageId, attempted, candidateCount) {
    const existing = this.retryTimers.get(messageId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.retryTimers.delete(messageId);
      this.inFlight.delete(messageId);
      if (attempted.size >= candidateCount) {
        this.attemptedPeers.delete(messageId);
      }
      this.forward().catch(() => {});
    }, this.ackTimeoutMs);
    this.retryTimers.set(messageId, timer);
  }

  async acknowledge(messageId, peerId) {
    const pending = this.inFlight.get(messageId);
    if (!pending || pending.peerId !== String(peerId)) return false;
    this.inFlight.delete(messageId);
    const timer = this.retryTimers.get(messageId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(messageId);
    this.attemptedPeers.delete(messageId);
    await this.relay.markForwarded(messageId);
    await this.forward();
    return true;
  }

  destroy() {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.inFlight.clear();
  }
}
