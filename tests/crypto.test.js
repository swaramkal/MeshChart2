import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CryptoService } from '../src/services/crypto.js';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true
  });
}

if (!globalThis.btoa) {
  globalThis.btoa = value =>
    Buffer.from(value, 'binary').toString('base64');
}

if (!globalThis.atob) {
  globalThis.atob = value =>
    Buffer.from(value, 'base64').toString('binary');
}

async function createPair(transcript = 'test-transcript-v1') {
  const alice = new CryptoService();
  const bob = new CryptoService();

  const [a, b] = await Promise.all([
    alice.createIdentity(),
    bob.createIdentity()
  ]);

  const [aliceMaterial, bobMaterial] = await Promise.all([
    alice.derivePairingMaterial(b.publicKey, transcript),
    bob.derivePairingMaterial(a.publicKey, transcript)
  ]);

  return { alice, bob, a, b, aliceMaterial, bobMaterial };
}

test('ECDH peers derive the same verification code', async () => {
  const pair = await createPair();

  assert.match(pair.aliceMaterial.verificationCode, /^\d{6}$/);

  assert.equal(
    pair.aliceMaterial.verificationCode,
    pair.bobMaterial.verificationCode
  );
});

test('ECDH peers derive compatible AES-GCM keys', async () => {
  const pair = await createPair();

  const envelope = await pair.alice.encrypt(
    pair.aliceMaterial.encryptionKey,
    'MeshChat secure pairing test',
    'peer-session-1'
  );

  const plaintext = await pair.bob.decrypt(
    pair.bobMaterial.encryptionKey,
    envelope,
    'peer-session-1'
  );

  assert.equal(plaintext, 'MeshChat secure pairing test');
});

test('AES-GCM rejects modified ciphertext', async () => {
  const pair = await createPair();

  const envelope = await pair.alice.encrypt(
    pair.aliceMaterial.encryptionKey,
    'protected message'
  );

  envelope.ciphertext =
    envelope.ciphertext.slice(0, -4) + 'AAAA';

  await assert.rejects(() =>
    pair.bob.decrypt(pair.bobMaterial.encryptionKey, envelope)
  );
});

test('confirmation MAC is verified only for the correct role and transcript', async () => {
  const pair = await createPair();

  const mac = await pair.alice.createConfirmationMac(
    pair.aliceMaterial.confirmationKey,
    'initiator',
    pair.aliceMaterial.transcriptHash
  );

  assert.equal(
    await pair.bob.verifyConfirmationMac(
      pair.bobMaterial.confirmationKey,
      'initiator',
      pair.bobMaterial.transcriptHash,
      mac
    ),
    true
  );

  assert.equal(
    await pair.bob.verifyConfirmationMac(
      pair.bobMaterial.confirmationKey,
      'responder',
      pair.bobMaterial.transcriptHash,
      mac
    ),
    false
  );

  assert.equal(
    await pair.bob.verifyConfirmationMac(
      pair.bobMaterial.confirmationKey,
      'initiator',
      'different-transcript',
      mac
    ),
    false
  );
});

test('different transcripts produce different verification codes', async () => {
  const pair = await createPair('transcript-one');

  const other = new CryptoService();
  const otherIdentity = await other.createIdentity();

  const otherMaterial = await other.derivePairingMaterial(
    pair.a.publicKey,
    'transcript-two'
  );

  assert.notEqual(
    pair.aliceMaterial.verificationCode,
    otherMaterial.verificationCode
  );

  assert.ok(otherIdentity.publicKey);
});

test('private identity key is non-extractable', async () => {
  const service = new CryptoService();

  await service.createIdentity();

  assert.equal(service.keyPair.privateKey.extractable, false);
});

test('invalid pairing roles are rejected', async () => {
  const pair = await createPair();

  await assert.rejects(() =>
    pair.alice.createConfirmationMac(
      pair.aliceMaterial.confirmationKey,
      'unknown',
      pair.aliceMaterial.transcriptHash
    )
  );
});

test('clearIdentity removes the temporary local identity', async () => {
  const service = new CryptoService();

  await service.createIdentity();
  service.clearIdentity();

  await assert.rejects(() =>
    service.derivePairingMaterial('invalid', 'test')
  );
});
