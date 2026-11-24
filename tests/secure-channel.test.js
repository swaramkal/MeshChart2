import test from 'node:test';
import assert from 'node:assert/strict';
import { CryptoService } from '../src/services/crypto.js';
import { sealPayload, openPacket } from '../src/services/secure-channel.js';

async function makePair() {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const base = { sessionId: 'a'.repeat(32), encryptionKey: key };

  return {
    service: new CryptoService(),
    alice: { ...base, role: 'initiator', receiveSeen: new Set(), receiveHighest: 0 },
    bob: { ...base, role: 'responder', receiveSeen: new Set(), receiveHighest: 0 }
  };
}

test('a message sent by one role is opened by the other', async () => {
  const { service, alice, bob } = await makePair();
  const packet = await sealPayload(service, alice, { kind: 'text', id: '1', text: 'hi' });
  const payload = await openPacket(service, bob, packet);

  assert.equal(payload.text, 'hi');
  assert.equal(payload.n, 1);
});

test('a replayed packet is rejected', async () => {
  const { service, alice, bob } = await makePair();
  const packet = await sealPayload(service, alice, { kind: 'text', id: '1', text: 'hi' });

  await openPacket(service, bob, packet);

  await assert.rejects(() => openPacket(service, bob, packet), /Replayed or stale/);
});

test('a message reflected back to its sender is rejected', async () => {
  const { service, alice } = await makePair();
  const packet = await sealPayload(service, alice, { kind: 'text', id: '1', text: 'hi' });

  await assert.rejects(() => openPacket(service, alice, packet));
});

test('slightly reordered packets are accepted once each', async () => {
  const { service, alice, bob } = await makePair();
  const first = await sealPayload(service, alice, { kind: 'text', id: '1', text: 'one' });
  const second = await sealPayload(service, alice, { kind: 'text', id: '2', text: 'two' });

  assert.equal((await openPacket(service, bob, second)).text, 'two');
  assert.equal((await openPacket(service, bob, first)).text, 'one');
  await assert.rejects(() => openPacket(service, bob, first), /Replayed or stale/);
});

test('packets older than the replay window are rejected', async () => {
  const { service, alice, bob } = await makePair();
  const old = await sealPayload(service, alice, { kind: 'text', id: '0', text: 'old' });

  for (let i = 0; i < 70; i++) {
    const packet = await sealPayload(service, alice, { kind: 'text', id: String(i), text: 'x' });
    await openPacket(service, bob, packet);
  }

  await assert.rejects(() => openPacket(service, bob, old), /Replayed or stale/);
});

test('tampered ciphertext and foreign sessions are not accepted', async () => {
  const { service, alice, bob } = await makePair();
  const packet = JSON.parse(
    await sealPayload(service, alice, { kind: 'text', id: '1', text: 'hi' })
  );

  const tampered = structuredClone(packet);
  tampered.encrypted.ciphertext = tampered.encrypted.ciphertext.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
  await assert.rejects(() => openPacket(service, bob, JSON.stringify(tampered)));

  const foreign = { ...packet, sessionId: 'b'.repeat(32) };
  assert.equal(await openPacket(service, bob, JSON.stringify(foreign)), null);
});

test('non-message and invalid data returns null instead of throwing', async () => {
  const { service, bob } = await makePair();

  assert.equal(await openPacket(service, bob, 'not json'), null);
  assert.equal(await openPacket(service, bob, JSON.stringify({ v: 2, type: 'hello' })), null);
});

test('oversized messages are refused before sending', async () => {
  const { service, alice } = await makePair();

  await assert.rejects(
    () => sealPayload(service, alice, { kind: 'text', id: '1', text: 'x'.repeat(3000) }),
    /too large/
  );
});
