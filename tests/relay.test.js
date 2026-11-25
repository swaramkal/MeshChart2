import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayService } from '../src/services/relay.js';

class MemoryRelayDatabase {
  constructor() { this.queue = new Map(); this.seen = new Map(); }
  async getRelaySeen(id) { return this.seen.get(id) || null; }
  async saveRelaySeen(item) { this.seen.set(item.id, item); }
  async getRelayPackets() { return [...this.queue.values()]; }
  async getRelayPacket(id) { return this.queue.get(id) || null; }
  async saveRelayPacket(item) { this.queue.set(item.id, item); }
  async reserveRelayPacket(item, { maxQueueItems, maxQueueBytes, now }) {
    const seen = this.seen.get(item.id);
    if (seen?.expiresAt > now) return { accepted: false, reason: 'duplicate' };
    const active = [...this.queue.values()].filter(packet => packet.expiresAt > now);
    const bytes = active.reduce((sum, packet) => sum + Math.floor(packet.ciphertext.length * 3 / 4), 0);
    const incoming = Math.floor(item.ciphertext.length * 3 / 4);
    if (active.length >= maxQueueItems || bytes + incoming > maxQueueBytes) return { accepted: false, reason: 'queue-full' };
    this.queue.set(item.id, item);
    this.seen.set(item.id, { id: item.id, expiresAt: item.expiresAt });
    return { accepted: true, reason: 'queued' };
  }
  async deleteRelayPacket(id) { this.queue.delete(id); }
  async clearRelayPackets() { this.queue.clear(); }
}

const makeEnvelope = (overrides = {}) => ({
  protocol: 'meshchat-relay-v1',
  id: 'msg_0123456789abcdef',
  ciphertext: 'c2VjdXJlLWVuY3J5cHRlZC1ieXRlcw==',
  createdAt: 10_000,
  expiresAt: 20_000,
  hopsRemaining: 4,
  ...overrides
});

test('relay is disabled by default and requires explicit opt-in', async () => {
  const relay = new RelayService(new MemoryRelayDatabase());
  assert.deepEqual(await relay.receive(makeEnvelope(), 11_000), { accepted: false, reason: 'relay-disabled' });
  relay.setEnabled(true);
  assert.equal((await relay.receive(makeEnvelope(), 11_000)).accepted, true);
});

test('rejects invalid relay source peer metadata', async () => {
  const relay = new RelayService(new MemoryRelayDatabase());
  relay.setEnabled(true);
  await assert.rejects(() => relay.receive(makeEnvelope(), 11_000, 'x'.repeat(129)), /source peer/);
});

test('accepts only bounded base64 opaque packets, not raw text', async () => {
  const relay = new RelayService(new MemoryRelayDatabase());
  relay.setEnabled(true);
  await assert.rejects(() => relay.receive(makeEnvelope({ ciphertext: 'hello world' }), 11_000), /base64 opaque packet/);
  await assert.rejects(() => relay.receive(makeEnvelope({ ciphertext: 'A'.repeat(30_000) }), 11_000), /base64 opaque packet/);
});

test('deduplicates message IDs and prevents repeated relay loops', async () => {
  const relay = new RelayService(new MemoryRelayDatabase());
  relay.setEnabled(true);
  assert.equal((await relay.receive(makeEnvelope(), 11_000)).accepted, true);
  assert.deepEqual(await relay.receive(makeEnvelope(), 11_100), { accepted: false, reason: 'duplicate' });
});

test('rejects expired packets and packets with no remaining hops', async () => {
  const relay = new RelayService(new MemoryRelayDatabase());
  relay.setEnabled(true);
  assert.throws(() => relay.createEnvelope({ id: 'msg_0123456789abcdef', ciphertext: 'YQ==', createdAt: 1, ttlMs: 0 }), /invalid lifetime|expired/i);
  assert.deepEqual(await relay.receive(makeEnvelope({ hopsRemaining: 0 }), 11_000), { accepted: false, reason: 'hop-limit' });
  await assert.rejects(() => relay.receive(makeEnvelope(), 21_000), /expired/);
});

test('decrements hop count before forwarding and retains ciphertext unchanged', async () => {
  const db = new MemoryRelayDatabase();
  const relay = new RelayService(db);
  relay.setEnabled(true);
  const original = makeEnvelope();
  await relay.receive(original, 11_000);
  const forwarded = await relay.prepareForward(original.id, 12_000);
  assert.equal(forwarded.hopsRemaining, 3);
  assert.equal(forwarded.ciphertext, original.ciphertext);
  assert.equal(forwarded.id, original.id);
  assert.equal('receivedAt' in forwarded, false);
});

test('removes queued packet only after successful forward acknowledgement', async () => {
  const db = new MemoryRelayDatabase();
  const relay = new RelayService(db);
  relay.setEnabled(true);
  const packet = makeEnvelope();
  await relay.receive(packet, 11_000);
  assert.ok(await relay.prepareForward(packet.id, 12_000));
  assert.ok(await db.getRelayPacket(packet.id));
  await relay.markForwarded(packet.id);
  assert.equal(await db.getRelayPacket(packet.id), null);
  assert.deepEqual(await relay.receive(packet, 12_100), { accepted: false, reason: 'duplicate' });
});

test('enforces queue item and byte quotas', async () => {
  const relay = new RelayService(new MemoryRelayDatabase(), { maxQueueItems: 1, maxQueueBytes: 100 });
  relay.setEnabled(true);
  assert.equal((await relay.receive(makeEnvelope(), 11_000)).accepted, true);
  assert.deepEqual(await relay.receive(makeEnvelope({ id: 'msg_1123456789abcdef' }), 11_000), { accepted: false, reason: 'queue-full' });
});

test('relay pause blocks forwarding and clearQueue removes queued data', async () => {
  const relay = new RelayService(new MemoryRelayDatabase());
  relay.setEnabled(true);
  const packet = makeEnvelope();
  await relay.receive(packet, 11_000);
  relay.setEnabled(false);
  assert.equal(await relay.prepareForward(packet.id, 12_000), null);
  relay.setEnabled(true);
  await relay.clearQueue();
  assert.equal((await relay.getQueueStatus(12_000)).queued, 0);
});


test('atomically reserves duplicate arrivals only once', async () => {
  const db = new MemoryRelayDatabase();
  const relay = new RelayService(db);
  relay.setEnabled(true);
  const packet = makeEnvelope();
  const results = await Promise.all([
    relay.receive(packet, 11_000),
    relay.receive(packet, 11_000),
    relay.receive(packet, 11_000)
  ]);
  assert.equal(results.filter(result => result.accepted).length, 1);
  assert.equal(results.filter(result => result.reason === 'duplicate').length, 2);
  assert.equal((await db.getRelayPackets()).length, 1);
});
