import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingController } from '../src/services/pairing.js';
import { CryptoService } from '../src/services/crypto.js';

async function makeIdentity() {
  const identity = await new CryptoService().createSigningIdentity();
  return { privateKey: identity.privateKey, publicKeySpki: identity.publicKeySpki };
}

class FakeBluetooth {
  constructor(id) {
    this.id = id;
    this.peers = new Map();
    this.messageHandlers = new Set();
    this.disconnectHandlers = new Set();
    this.remote = null;
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
    await Promise.all(
      [...this.remote.messageHandlers].map(callback =>
        callback({ data, peerId: this.id })
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

  throw new Error('Timed out waiting for pairing state.');
}

test('two devices derive the same code and establish only after both confirmations', async () => {
  const a = new FakeBluetooth('device-a');
  const b = new FakeBluetooth('device-b');
  a.remote = b;
  b.remote = a;

  a.peers.set('device-b', { name: 'Phone B' });
  b.peers.set('device-a', { name: 'Phone A' });

  const statesA = [];
  const statesB = [];

  const identityA = await makeIdentity();
  const identityB = await makeIdentity();

  const pairingA = new PairingController(a, {
    onState: state => statesA.push(state),
    getIdentity: async () => identityA
  });

  const pairingB = new PairingController(b, {
    onState: state => statesB.push(state),
    getIdentity: async () => identityB
  });

  try {
    await pairingA.start('device-b', 'Phone B');

    await waitFor(() =>
      pairingA.sessions.get('device-b')?.material &&
      pairingB.sessions.get('device-a')?.material
    );

    const codeA = pairingA.sessions.get('device-b').material.verificationCode;
    const codeB = pairingB.sessions.get('device-a').material.verificationCode;

    assert.match(codeA, /^\d{6}$/);
    assert.equal(codeA, codeB);

    await pairingA.confirmLocal('device-b');

    assert.equal(pairingA.isSecure('device-b'), false);
    assert.equal(pairingB.isSecure('device-a'), false);

    await pairingB.confirmLocal('device-a');

    await waitFor(() =>
      pairingA.isSecure('device-b') &&
      pairingB.isSecure('device-a')
    );

    assert.equal(pairingA.isSecure('device-b'), true);
    assert.equal(pairingB.isSecure('device-a'), true);
    assert.ok(statesA.some(state => state.status === 'secure'));
    assert.ok(statesB.some(state => state.status === 'secure'));
  } finally {
    pairingA.destroy();
    pairingB.destroy();
  }
});

test('Bluetooth message listeners do not overwrite each other', async () => {
  const bluetooth = new FakeBluetooth('test');
  let first = 0;
  let second = 0;

  const removeFirst = bluetooth.onMessage(() => first++);
  bluetooth.onMessage(() => second++);

  for (const callback of bluetooth.messageHandlers) {
    callback({ data: 'test', peerId: 'peer' });
  }

  assert.equal(first, 1);
  assert.equal(second, 1);

  removeFirst();

  for (const callback of bluetooth.messageHandlers) {
    callback({ data: 'test', peerId: 'peer' });
  }

  assert.equal(first, 1);
  assert.equal(second, 2);
});
