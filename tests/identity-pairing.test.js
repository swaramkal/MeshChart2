import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingController } from '../src/services/pairing.js';
import { CryptoService } from '../src/services/crypto.js';
import { sealPayload, openPacket } from '../src/services/secure-channel.js';

class FakeBluetooth {
  constructor(id) {
    this.id = id;
    this.peers = new Map();
    this.messageHandlers = new Set();
    this.disconnectHandlers = new Set();
    this.remote = null;
    this.tamper = null;
  }

  onMessage(callback) {
    this.messageHandlers.add(callback);
    return () => this.messageHandlers.delete(callback);
  }

  onDisconnect(callback) {
    this.disconnectHandlers.add(callback);
    return () => this.disconnectHandlers.delete(callback);
  }

  async send(data) {
    const outgoing = this.tamper ? this.tamper(data) : data;

    await Promise.all(
      [...this.remote.messageHandlers].map(callback =>
        callback({ data: outgoing, peerId: this.id })
      )
    );
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await pause(10);
  }
  throw new Error('Timed out.');
}

async function makeIdentity() {
  const service = new CryptoService();
  const identity = await service.createSigningIdentity();
  return {
    privateKey: identity.privateKey,
    publicKeySpki: identity.publicKeySpki,
    fingerprint: await service.fingerprintOf(identity.publicKeySpki)
  };
}

function link(idA = 'addr-a', idB = 'addr-b') {
  const a = new FakeBluetooth(idA);
  const b = new FakeBluetooth(idB);
  a.remote = b;
  b.remote = a;
  a.peers.set(idB, { name: 'Phone B' });
  b.peers.set(idA, { name: 'Phone A' });
  return { a, b };
}

test('first pairing needs both codes confirmed and pins the identity', async () => {
  const { a, b } = link();
  const idA = await makeIdentity();
  const idB = await makeIdentity();
  const secured = [];

  const pairingA = new PairingController(a, {
    getIdentity: async () => idA,
    onSecure: (peer, session) => secured.push(session.remoteFingerprint)
  });
  const pairingB = new PairingController(b, { getIdentity: async () => idB });

  try {
    await pairingA.start('addr-b', 'Phone B');
    await waitFor(() =>
      pairingA.sessions.get('addr-b')?.material &&
      pairingB.sessions.get('addr-a')?.material
    );

    assert.equal(pairingA.sessions.get('addr-b').trusted, false);

    await pairingA.confirmLocal('addr-b');
    await pairingB.confirmLocal('addr-a');
    await waitFor(() => pairingA.isSecure('addr-b') && pairingB.isSecure('addr-a'));

    assert.deepEqual(secured, [idB.fingerprint]);
    assert.equal(pairingA.getSecureSession('addr-b').role, 'initiator');
    assert.equal(pairingB.getSecureSession('addr-a').role, 'responder');
  } finally {
    pairingA.destroy();
    pairingB.destroy();
  }
});

test('a pinned contact reconnecting from a new address is confirmed automatically', async () => {
  const idA = await makeIdentity();
  const idB = await makeIdentity();

  // Second connection: B now appears under a different Bluetooth address.
  const { a, b } = link('addr-a2', 'addr-b2');

  const pairingA = new PairingController(a, {
    getIdentity: async () => idA,
    findTrusted: async fp => (fp === idB.fingerprint ? { name: 'B' } : null)
  });
  const pairingB = new PairingController(b, {
    getIdentity: async () => idB,
    findTrusted: async fp => (fp === idA.fingerprint ? { name: 'A' } : null)
  });

  try {
    await pairingA.start('addr-b2', 'Phone B');

    await waitFor(() => pairingA.isSecure('addr-b2') && pairingB.isSecure('addr-a2'));

    assert.equal(pairingA.getSecureSession('addr-b2').wasTrusted, true);
    assert.equal(pairingB.getSecureSession('addr-a2').wasTrusted, true);

    // The resulting session carries real encrypted traffic both ways.
    const service = new CryptoService();
    const sessionA = pairingA.getSecureSession('addr-b2');
    const sessionB = pairingB.getSecureSession('addr-a2');

    const packet = await sealPayload(service, sessionA, { kind: 'text', id: '1', text: 'welcome back' });
    assert.equal((await openPacket(service, sessionB, packet)).text, 'welcome back');
  } finally {
    pairingA.destroy();
    pairingB.destroy();
  }
});

test('an impostor presenting a pinned identity key cannot sign for it', async () => {
  const idA = await makeIdentity();
  const idB = await makeIdentity();
  const impostor = await makeIdentity();

  const { a, b } = link('addr-a3', 'addr-b3');

  // The impostor copies B's PUBLIC identity key but only holds its own
  // private key, so its confirmation signature cannot verify.
  const forged = {
    privateKey: impostor.privateKey,
    publicKeySpki: idB.publicKeySpki
  };

  const statesA = [];
  const pairingA = new PairingController(a, {
    getIdentity: async () => idA,
    findTrusted: async fp => (fp === idB.fingerprint ? { name: 'B' } : null),
    onState: state => statesA.push(state.status)
  });
  const pairingFake = new PairingController(b, { getIdentity: async () => forged });

  try {
    await pairingA.start('addr-b3', 'Phone B');

    // The impostor user confirms on its side; its signature must not verify.
    await waitFor(() => pairingFake.sessions.get('addr-a3')?.material);
    await pairingFake.confirmLocal('addr-a3');

    await waitFor(() => statesA.includes('verification-failed'));

    assert.equal(pairingA.isSecure('addr-b3'), false);
  } finally {
    pairingA.destroy();
    pairingFake.destroy();
  }
});

test('a man-in-the-middle swapping the ephemeral key breaks verification', async () => {
  const idA = await makeIdentity();
  const idB = await makeIdentity();
  const { a, b } = link('addr-a4', 'addr-b4');

  // Corrupt B's ephemeral public key in the ack so A and B disagree.
  const other = await new CryptoService().createIdentity();
  b.tamper = data => {
    const packet = JSON.parse(data);
    if (packet.type === 'ack') packet.publicKey = other.publicKey;
    return JSON.stringify(packet);
  };

  const statesB = [];
  const pairingA = new PairingController(a, { getIdentity: async () => idA });
  const pairingB = new PairingController(b, {
    getIdentity: async () => idB,
    onState: state => statesB.push(state.status)
  });

  try {
    await pairingA.start('addr-b4', 'Phone B');
    await waitFor(() => pairingA.sessions.get('addr-b4')?.material);
    await waitFor(() => pairingB.sessions.get('addr-a4')?.material);

    const codeA = pairingA.sessions.get('addr-b4').material.verificationCode;
    const codeB = pairingB.sessions.get('addr-a4').material.verificationCode;
    assert.notEqual(codeA, codeB);

    // Even if a user confirmed anyway, the key confirmations cannot match.
    await pairingA.confirmLocal('addr-b4');
    await waitFor(() => statesB.includes('verification-failed'));

    assert.equal(pairingA.isSecure('addr-b4'), false);
    assert.equal(pairingB.isSecure('addr-a4'), false);
  } finally {
    pairingA.destroy();
    pairingB.destroy();
  }
});

test('a disconnect without any pairing does not raise pairing UI', async () => {
  const { a } = link();
  const idA = await makeIdentity();
  const states = [];
  const pairing = new PairingController(a, {
    getIdentity: async () => idA,
    onState: state => states.push(state)
  });

  pairing.cancel('never-paired', 'disconnected', false);
  assert.equal(states.length, 0);
  pairing.destroy();
});

test('the identity fingerprint is stable and 64 hex characters', async () => {
  const service = new CryptoService();
  const identity = await service.createSigningIdentity();
  const first = await service.fingerprintOf(identity.publicKeySpki);
  const second = await service.fingerprintOf(identity.publicKeySpki);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});
