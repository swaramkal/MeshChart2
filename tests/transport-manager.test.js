import test from 'node:test';
import assert from 'node:assert/strict';
import { TransportManager } from '../src/services/transport-manager.js';

class FakeAdapter {
  constructor(name) {
    this.name = name;
    this.peers = new Map();
    this.peerListeners = new Set();
    this.messageListeners = new Set();
    this.disconnectListeners = new Set();
    this.incomingListeners = new Set();
    this.connectCalls = [];
    this.sendCalls = [];
    this.connectError = null;
    this.sendError = null;
  }
  onPeer(callback) { this.peerListeners.add(callback); }
  onMessage(callback) { this.messageListeners.add(callback); }
  onDisconnect(callback) { this.disconnectListeners.add(callback); }
  onIncomingConnection(callback) { this.incomingListeners.add(callback); }
  discover(peer) {
    this.peers.set(peer.id, peer);
    for (const callback of this.peerListeners) callback(peer);
  }
  async startScan() {}
  async stopScan() {}
  async connect(id) {
    this.connectCalls.push(id);
    if (this.connectError) throw this.connectError;
    const peer = { ...this.peers.get(id), id, connected: true };
    for (const callback of this.peerListeners) callback(peer);
    return { deviceId: id };
  }
  async send(data, id) {
    this.sendCalls.push({ data, id });
    if (this.sendError) throw this.sendError;
    return { bytesSent: data.length };
  }
  async disconnect(id) {
    for (const callback of this.disconnectListeners) callback(id);
  }
  drop(id) {
    for (const callback of this.disconnectListeners) callback(id);
  }
}

function setup(options = {}) {
  const bluetooth = new FakeAdapter('bluetooth');
  const wifiDirect = new FakeAdapter('wifi-direct');
  const manager = new TransportManager({ bluetooth, wifiDirect, ...options });
  return { bluetooth, wifiDirect, manager };
}

test('transport selection prefers Wi-Fi Direct and sends once', async () => {
  const { bluetooth, wifiDirect, manager } = setup();
  bluetooth.discover({ id: 'peer-1', name: 'Phone', connected: false });
  wifiDirect.discover({ id: 'peer-1', name: 'Phone', connected: false });

  const connected = await manager.connect('peer-1');
  const sent = await manager.send('ciphertext', 'peer-1');

  assert.equal(connected.transport, 'wifi-direct');
  assert.equal(sent.transport, 'wifi-direct');
  assert.equal(wifiDirect.connectCalls.length, 1);
  assert.equal(wifiDirect.sendCalls.length, 1);
  assert.equal(bluetooth.sendCalls.length, 0);
});

test('connection selection falls back when Wi-Fi Direct cannot connect', async () => {
  const { bluetooth, wifiDirect, manager } = setup();
  bluetooth.discover({ id: 'peer-2', name: 'Phone', connected: false });
  wifiDirect.discover({ id: 'peer-2', name: 'Phone', connected: false });
  wifiDirect.connectError = new Error('radio unavailable');

  const result = await manager.connect('peer-2');
  assert.equal(result.transport, 'bluetooth');
  assert.deepEqual(wifiDirect.connectCalls, ['peer-2']);
  assert.deepEqual(bluetooth.connectCalls, ['peer-2']);
});

test('send falls back after one transport failure without broadcasting copies', async () => {
  const { bluetooth, wifiDirect, manager } = setup();
  bluetooth.discover({ id: 'peer-3', name: 'Phone', connected: true });
  wifiDirect.discover({ id: 'peer-3', name: 'Phone', connected: true });
  wifiDirect.sendError = new Error('socket closed');

  const result = await manager.send('same encrypted packet', 'peer-3');
  assert.equal(result.transport, 'bluetooth');
  assert.equal(wifiDirect.sendCalls.length, 1);
  assert.equal(bluetooth.sendCalls.length, 1);
  assert.equal(bluetooth.sendCalls[0].data, 'same encrypted packet');
});

test('trusted identity association lets the manager find a Wi-Fi alias', async () => {
  const { bluetooth, wifiDirect, manager } = setup();
  const fingerprint = 'a'.repeat(64);
  bluetooth.discover({ id: 'ble-address', name: 'Phone', connected: true });
  wifiDirect.discover({
    id: fingerprint,
    name: 'Phone',
    connected: true,
    identityFingerprintHint: fingerprint
  });
  manager.associateIdentity('ble-address', fingerprint);

  assert.equal(manager.getPeerFingerprint('ble-address'), fingerprint);
  assert.equal(manager.connectedCandidates('ble-address').length, 2);
});

test('disconnecting one trusted alias does not report the contact offline while another link remains', async () => {
  const { bluetooth, wifiDirect, manager } = setup();
  const fingerprint = 'c'.repeat(64);
  bluetooth.discover({ id: 'ble-peer', name: 'Phone', connected: true });
  wifiDirect.discover({
    id: fingerprint,
    name: 'Phone',
    connected: true,
    identityFingerprintHint: fingerprint
  });
  manager.associateIdentity('ble-peer', fingerprint);
  let disconnected = 0;
  manager.onDisconnect(() => disconnected++);

  wifiDirect.drop(fingerprint);
  assert.equal(disconnected, 0);
  assert.equal(manager.connectedCandidates('ble-peer').length, 1);
});

test('bounded reconnect attempts run after unexpected disconnect', async () => {
  const { bluetooth, manager } = setup({ reconnectDelays: [0] });
  bluetooth.discover({ id: 'peer-4', name: 'Phone', connected: false });
  await manager.connect('peer-4');
  bluetooth.drop('peer-4');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(bluetooth.connectCalls.length, 2);
  await manager.destroy();
});
