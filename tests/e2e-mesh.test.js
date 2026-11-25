import test from 'node:test';
import assert from 'node:assert/strict';
import { CryptoService } from '../src/services/crypto.js';
import { E2EService, MAX_MESH_TEXT_BYTES } from '../src/services/e2e.js';
import { RelayService } from '../src/services/relay.js';
import { RelayTransportBridge } from '../src/services/relay-transport.js';
import { sealPayload } from '../src/services/secure-channel.js';

class RelayDb {
  constructor() { this.queue = new Map(); this.seen = new Map(); }
  async cleanupRelayData(now) { for (const [id, p] of this.queue) if (p.expiresAt <= now) this.queue.delete(id); }
  async reserveRelayPacket(packet, { maxQueueItems, now }) {
    const seen = this.seen.get(packet.id);
    if (seen?.expiresAt > now) return { accepted: false, reason: 'duplicate' };
    if (this.queue.size >= maxQueueItems) return { accepted: false, reason: 'queue-full' };
    this.queue.set(packet.id, packet);
    this.seen.set(packet.id, { expiresAt: packet.expiresAt });
    return { accepted: true, reason: 'queued' };
  }
  async getRelayPackets() { return [...this.queue.values()]; }
  async getRelayPacket(id) { return this.queue.get(id) || null; }
  async deleteRelayPacket(id) { this.queue.delete(id); }
}

// Acks travel over the network, so they never arrive inside the send call.
const later = (fn) => setTimeout(() => fn().catch(() => {}), 1);
const meshNodes = [];
test.afterEach(() => { for (const n of meshNodes) n.bridge?.destroy(); meshNodes.length = 0; });
const cs = new CryptoService();
const e2e = new E2EService(cs);

async function makeNode(name) {
  const id = await cs.createSigningIdentity();
  const box = await e2e.createBoxIdentity();
  return { name, id, box, fp: await cs.fingerprintOf(id.publicKeySpki), contacts: new Map(), inbox: [] };
}
const meet = (x, y) => {
  x.contacts.set(y.fp, y.id.publicKeySpki); y.contacts.set(x.fp, x.id.publicKeySpki);
};

// Wires a bridge per node; links are [nodeA,nodeB] pairs.
function buildMesh(nodes, links, { relayOn = [] } = {}) {
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  meshNodes.push(...nodes);
  for (const n of nodes) {
    n.relay = new RelayService(new RelayDb());
    n.relay.setEnabled(relayOn.includes(n.name));
    const peers = () => links.filter((l) => l.includes(n.name)).map((l) => {
      const other = l.find((x) => x !== n.name);
      return { id: other, connected: true, fingerprint: byName[other].fp };
    });
    n.bridge = new RelayTransportBridge({
      relay: n.relay, getPeers: peers, ackTimeoutMs: 20,
      sendEnvelope: async (to, envelope) => {
        const target = byName[to];
        await target.receiveEnvelope(envelope, n.name);
      }
    });
    n.receiveEnvelope = async (envelope, from) => {
      if (e2e.isForMe(envelope.ciphertext, n.fp)) {
        try {
          const body = await e2e.open({ ciphertext: envelope.ciphertext, boxPrivateKey: n.box.privateKey,
            myFingerprint: n.fp, lookupIdentityKey: async (fp) => n.contacts.get(fp) || null });
          n.inbox.push(body);
          later(() => byName[from].bridge.acknowledge(envelope.id, n.name));
        } catch (error) { n.errors = [...(n.errors || []), error.message]; }
        return;
      }
      const result = await n.bridge.receive(envelope, from);
      if (['queued', 'duplicate'].includes(result.reason)) later(() => byName[from].bridge.acknowledge(envelope.id, n.name));
    };
  }
}

async function send(from, to, text, extra = {}) {
  const sealed = await e2e.seal({ identityPrivateKey: from.id.privateKey, fromFingerprint: from.fp,
    toFingerprint: to.fp, recipientBoxKey: to.box.publicKeySpki, kind: 'text', id: extra.id || `msg_${Math.random().toString(36).slice(2, 12)}`, text });
  const envelope = from.relay.createEnvelope({ id: extra.id || JSON.parse(atob(sealed)).iv.replace(/[^A-Za-z0-9]/g, '').slice(0, 20).padEnd(16, 'x'), ciphertext: sealed, hops: extra.hops ?? 8 });
  await from.relay.originate(envelope);
  await from.bridge.forward();
  return envelope;
}

test('A -> B -> C: C reads the message, B (relay) cannot, A needs no relay setting', async () => {
  const [A, B, C] = await Promise.all(['A', 'B', 'C'].map(makeNode));
  meet(A, C); meet(A, B); meet(B, C);
  buildMesh([A, B, C], [['A', 'B'], ['B', 'C']], { relayOn: ['B'] });
  const env = await send(A, C, 'hello from A through B');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(C.inbox.length, 1);
  assert.equal(C.inbox[0].text, 'hello from A through B');
  assert.equal(C.inbox[0].from, A.fp);
  assert.ok(!atob(env.ciphertext).includes('hello'), 'relay blob must not contain plaintext');
  await assert.rejects(() => e2e.open({ ciphertext: env.ciphertext, boxPrivateKey: B.box.privateKey, myFingerprint: B.fp,
    lookupIdentityKey: async () => A.id.publicKeySpki }), /Not addressed/);
  assert.equal((await A.relay.db.getRelayPackets()).length, 0);
  assert.equal((await B.relay.db.getRelayPackets()).length, 0);
});

test('a relay with relay mode off does not forward other people\'s messages', async () => {
  const [A, B, C] = await Promise.all(['A', 'B', 'C'].map(makeNode));
  meet(A, C);
  buildMesh([A, B, C], [['A', 'B'], ['B', 'C']], { relayOn: [] });
  await send(A, C, 'blocked');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(C.inbox.length, 0);
  assert.equal((await A.relay.db.getRelayPackets()).length, 1, 'A keeps it queued for later');
});

test('two relay hops (A -> B -> D -> C) deliver', async () => {
  const [A, B, D, C] = await Promise.all(['A', 'B', 'D', 'C'].map(makeNode));
  meet(A, C);
  buildMesh([A, B, D, C], [['A', 'B'], ['B', 'D'], ['D', 'C']], { relayOn: ['B', 'D'] });
  await send(A, C, 'two hops');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(C.inbox[0]?.text, 'two hops');
});

test('hop limit stops delivery when too many relays are needed', async () => {
  const [A, B, D, C] = await Promise.all(['A', 'B', 'D', 'C'].map(makeNode));
  meet(A, C);
  buildMesh([A, B, D, C], [['A', 'B'], ['B', 'D'], ['D', 'C']], { relayOn: ['B', 'D'] });
  await send(A, C, 'too far', { hops: 2 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(C.inbox.length, 0);
});

test('forged sender, tampering, unknown sender, expiry and wrong recipient are rejected', async () => {
  const [A, C, X] = await Promise.all(['A', 'C', 'X'].map(makeNode));
  meet(A, C);
  const lookup = async (fp) => C.contacts.get(fp) || null;
  const seal = (from, extra = {}) => e2e.seal({ identityPrivateKey: from.id.privateKey, fromFingerprint: extra.claim || from.fp,
    toFingerprint: C.fp, recipientBoxKey: C.box.publicKeySpki, kind: 'text', id: 'msg_abcdefgh12', text: 'hi', now: extra.now });
  const open = (ciphertext, myFingerprint = C.fp, key = C.box.privateKey, now) =>
    e2e.open({ ciphertext, boxPrivateKey: key, myFingerprint, lookupIdentityKey: lookup, now });

  assert.equal((await open(await seal(A))).text, 'hi');
  await assert.rejects(async () => open(await seal(X)), /not a verified contact/);                 // stranger
  await assert.rejects(async () => open(await seal(X, { claim: A.fp })), /signature is invalid/);  // forged "from A"
  await assert.rejects(async () => open(await seal(A, { now: Date.now() - 25 * 3600_000 })), /too old/);
  await assert.rejects(async () => open(await seal(A, { now: Date.now() + 3600_000 })), /too old/);
  const good = await seal(A);
  const blob = JSON.parse(atob(good));
  blob.c = blob.c.slice(0, -6) + 'AAAAAA';
  await assert.rejects(() => open(btoa(JSON.stringify(blob))), /decrypted/);                 // tampered
  await assert.rejects(() => open('not-a-blob'), /Not addressed/);
  assert.equal(e2e.isForMe(good, X.fp), false);
});

test('oversized relay-chat text still fits one secure-channel packet', async () => {
  const [A, C] = await Promise.all(['A', 'C'].map(makeNode));
  const text = 'é'.repeat(MAX_MESH_TEXT_BYTES / 2);
  const sealed = await e2e.seal({ identityPrivateKey: A.id.privateKey, fromFingerprint: A.fp, toFingerprint: C.fp,
    recipientBoxKey: C.box.publicKeySpki, kind: 'text', id: crypto.randomUUID(), text });
  const relay = new RelayService(new RelayDb());
  const envelope = relay.createEnvelope({ id: crypto.randomUUID(), ciphertext: sealed });
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const packet = await sealPayload(cs, { sessionId: 'c'.repeat(32), encryptionKey: key, role: 'initiator' },
    { kind: 'relay-envelope', envelope });
  assert.ok(Buffer.byteLength(packet) <= 2900, `packet was ${Buffer.byteLength(packet)} bytes`);
});

test('invalid box keys are refused', async () => {
  assert.equal(await e2e.isValidBoxKey('AAAA'), false);
  assert.equal(await e2e.isValidBoxKey((await makeNode('Z')).box.publicKeySpki), true);
});
