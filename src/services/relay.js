const PROTOCOL = 'meshchat-relay-v1';
const MAX_HOPS = 8;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const MAX_QUEUE_ITEMS = 100;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function isBase64(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeBase64Size(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function validateEnvelope(envelope, now) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Invalid relay envelope.');
  }
  if (envelope.protocol !== PROTOCOL) throw new Error('Unsupported relay protocol.');
  if (typeof envelope.id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(envelope.id)) {
    throw new Error('Invalid relay message ID.');
  }
  if (!isBase64(envelope.ciphertext) || decodeBase64Size(envelope.ciphertext) > MAX_CIPHERTEXT_BYTES) {
    throw new Error('Relay payload must be a bounded base64 opaque packet.');
  }
  if (!Number.isSafeInteger(envelope.createdAt) || !Number.isSafeInteger(envelope.expiresAt)) {
    throw new Error('Invalid relay timestamps.');
  }
  if (envelope.createdAt > now + MAX_CLOCK_SKEW_MS || envelope.expiresAt <= now ||
      envelope.expiresAt <= envelope.createdAt ||
      envelope.expiresAt - envelope.createdAt > MAX_TTL_MS) {
    throw new Error('Relay packet is expired or has an invalid lifetime.');
  }
  if (!Number.isInteger(envelope.hopsRemaining) || envelope.hopsRemaining < 0 || envelope.hopsRemaining > MAX_HOPS) {
    throw new Error('Invalid relay hop limit.');
  }
  return true;
}

/**
 * Store-and-forward policy for opaque packet bytes. Callers must supply an
 * end-to-end encrypted packet; this module validates framing/size but cannot
 * cryptographically prove that arbitrary bytes are ciphertext. It does not
 * discover peers or transmit packets; a native transport
 * must call receive() and send the result of prepareForward().
 */
export class RelayService {
  constructor(database, { maxQueueItems = MAX_QUEUE_ITEMS, maxQueueBytes = MAX_QUEUE_BYTES } = {}) {
    if (!database) throw new Error('A relay database is required.');
    this.db = database;
    this.maxQueueItems = maxQueueItems;
    this.maxQueueBytes = maxQueueBytes;
    this.enabled = false;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    return this.enabled;
  }

  createEnvelope({ id, ciphertext, createdAt = Date.now(), ttlMs = 60 * 60 * 1000, hops = MAX_HOPS }) {
    const envelope = {
      protocol: PROTOCOL,
      id,
      ciphertext,
      createdAt,
      expiresAt: createdAt + ttlMs,
      hopsRemaining: hops
    };
    validateEnvelope(envelope, createdAt);
    return envelope;
  }

  async receive(envelope, now = Date.now(), receivedFrom = null) {
    if (!this.enabled) return { accepted: false, reason: 'relay-disabled' };
    validateEnvelope(envelope, now);
    if (envelope.hopsRemaining <= 0) return { accepted: false, reason: 'hop-limit' };
    if (receivedFrom !== null && (typeof receivedFrom !== 'string' || receivedFrom.length > 128)) {
      throw new Error('Invalid relay source peer.');
    }

    await this.db.cleanupRelayData?.(now);
    const packet = {
      ...envelope,
      receivedAt: now,
      ...(receivedFrom ? { receivedFrom } : {})
    };

    // Real IndexedDB storage reserves queue + deduplication records in one
    // read/write transaction. The fallback keeps lightweight test adapters
    // compatible; production storage always uses the atomic path.
    if (typeof this.db.reserveRelayPacket === 'function') {
      return this.db.reserveRelayPacket(packet, {
        maxQueueItems: this.maxQueueItems,
        maxQueueBytes: this.maxQueueBytes,
        now
      });
    }

    const seen = await this.db.getRelaySeen(envelope.id);
    if (seen && seen.expiresAt > now) return { accepted: false, reason: 'duplicate' };
    const queued = await this.db.getRelayPackets();
    const bytes = queued.reduce((sum, item) => sum + decodeBase64Size(item.ciphertext), 0);
    const incomingBytes = decodeBase64Size(envelope.ciphertext);
    if (queued.length >= this.maxQueueItems || bytes + incomingBytes > this.maxQueueBytes) {
      return { accepted: false, reason: 'queue-full' };
    }
    await this.db.saveRelayPacket(packet);
    await this.db.saveRelaySeen({ id: envelope.id, expiresAt: envelope.expiresAt });
    return { accepted: true, reason: 'queued' };
  }

  async prepareForward(messageId, now = Date.now()) {
    if (!this.enabled) return null;
    const packet = await this.db.getRelayPacket(messageId);
    if (!packet) return null;
    if (packet.expiresAt <= now || packet.hopsRemaining <= 0) {
      await this.db.deleteRelayPacket(messageId);
      return null;
    }

    const forwarded = {
      protocol: packet.protocol,
      id: packet.id,
      ciphertext: packet.ciphertext,
      createdAt: packet.createdAt,
      expiresAt: packet.expiresAt,
      hopsRemaining: packet.hopsRemaining - 1
    };
    validateEnvelope(forwarded, now);
    return forwarded;
  }

  async markForwarded(messageId) {
    await this.db.deleteRelayPacket(messageId);
  }

  async getQueueStatus(now = Date.now()) {
    const packets = await this.db.getRelayPackets();
    const active = packets.filter(packet => packet.expiresAt > now && packet.hopsRemaining > 0);
    return {
      enabled: this.enabled,
      queued: active.length,
      bytes: active.reduce((sum, item) => sum + decodeBase64Size(item.ciphertext), 0)
    };
  }

  async clearQueue() {
    await this.db.clearRelayPackets();
  }
}

export const RELAY_PROTOCOL = PROTOCOL;
