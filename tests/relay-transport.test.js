import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayService } from '../src/services/relay.js';
import { RelayTransportBridge } from '../src/services/relay-transport.js';

class RelayDb {
  constructor() { this.queue = new Map(); this.seen = new Map(); }
  async cleanupRelayData(now) {
    for (const [id, packet] of this.queue) if (packet.expiresAt <= now) this.queue.delete(id);
    for (const [id, record] of this.seen) if (record.expiresAt <= now) this.seen.delete(id);
  }
  async reserveRelayPacket(packet, { maxQueueItems, maxQueueBytes, now }) {
    const seen = this.seen.get(packet.id);
    if (seen?.expiresAt > now) return { accepted: false, reason: 'duplicate' };
    const active = [...this.queue.values()].filter((item) => item.expiresAt > now);
    const bytes = active.reduce((sum, item) => sum + Math.floor(item.ciphertext.length * 3 / 4), 0);
    const incoming = Math.floor(packet.ciphertext.length * 3 / 4);
    if (active.length >= maxQueueItems || bytes + incoming > maxQueueBytes) return { accepted: false, reason: 'queue-full' };
    this.queue.set(packet.id, packet);
    this.seen.set(packet.id, { id: packet.id, expiresAt: packet.expiresAt });
    return { accepted: true, reason: 'queued' };
  }
  async getRelayPackets() { return [...this.queue.values()]; }
  async getRelayPacket(id) { return this.queue.get(id) || null; }
  async deleteRelayPacket(id) { this.queue.delete(id); }
  async getRelaySeen(id) { return this.seen.get(id) || null; }
  async saveRelaySeen(record) { this.seen.set(record.id, record); }
  async saveRelayPacket(packet) { this.queue.set(packet.id, packet); }
  async clearRelayPackets() { this.queue.clear(); }
}

const envelope = {
  protocol: 'meshchat-relay-v1',
  id: 'msg_0123456789abcdef',
  ciphertext: 'c2VjdXJlLWVuY3J5cHRlZC1ieXRlcw==',
  createdAt: 10_000,
  expiresAt: 20_000,
  hopsRemaining: 4
};

test('relay transport forwards opaque envelopes over a secure connected hop', async () => {
  const db = new RelayDb();
  const relay = new RelayService(db);
  relay.setEnabled(true);
  const transmissions = [];
  const peers = [
    { id: 'previous-hop', connected: true, fingerprint: 'a'.repeat(64) },
    { id: 'next-hop', connected: true, fingerprint: 'b'.repeat(64) }
  ];
  const bridge = new RelayTransportBridge({
    relay,
    getPeers: () => peers,
    sendEnvelope: async (peerId, packet) => transmissions.push({ peerId, packet }),
    ackTimeoutMs: 60_000
  });

  const result = await bridge.receive(envelope, 'previous-hop', 11_000);
  assert.equal(result.accepted, true);
  assert.equal(transmissions.length, 1);
  assert.equal(transmissions[0].peerId, 'next-hop');
  assert.equal(transmissions[0].packet.hopsRemaining, 3);
  assert.equal(transmissions[0].packet.ciphertext, envelope.ciphertext);
  assert.ok(await db.getRelayPacket(envelope.id));

  assert.equal(await bridge.acknowledge(envelope.id, 'unrelated-peer'), false);
  assert.ok(await db.getRelayPacket(envelope.id));
  assert.equal(await bridge.acknowledge(envelope.id, 'next-hop'), true);
  assert.equal(await db.getRelayPacket(envelope.id), null);
  bridge.destroy();
});

test('relay bridge retains packets when the next transport send fails', async () => {
  const db = new RelayDb();
  const relay = new RelayService(db);
  relay.setEnabled(true);
  const bridge = new RelayTransportBridge({
    relay,
    getPeers: () => [{ id: 'next-hop', connected: true }],
    sendEnvelope: async () => { throw new Error('socket lost'); },
    ackTimeoutMs: 60_000
  });

  const result = await bridge.receive(envelope, 'previous-hop', 11_000);
  assert.equal(result.accepted, true);
  assert.ok(await db.getRelayPacket(envelope.id));
  bridge.destroy();
});
