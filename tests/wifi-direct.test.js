import test from 'node:test';
import assert from 'node:assert/strict';
import { WifiDirectAdapter } from '../src/services/wifi-direct.js';

function makePlugin() {
  const handlers = new Map();
  return {
    handlers,
    calls: [],
    async addListener(name, callback) {
      handlers.set(name, callback);
      return { remove: async () => handlers.delete(name) };
    },
    async startDiscovery(options) { this.calls.push(['startDiscovery', options]); },
    async stopDiscovery() { this.calls.push(['stopDiscovery']); },
    async updateIdentity(options) { this.calls.push(['updateIdentity', options]); },
    async connect(options) {
      this.calls.push(['connect', options]);
      handlers.get('onPeerConnected')?.({
        deviceId: 'b'.repeat(64),
        deviceName: 'Phone B',
        fingerprint: 'b'.repeat(64),
        initiated: true
      });
      return { deviceId: 'b'.repeat(64), deviceName: 'Phone B' };
    },
    async sendPacket(options) { this.calls.push(['sendPacket', options]); },
    async disconnect(options) { this.calls.push(['disconnect', options]); }
  };
}

function withPlugin(plugin, run) {
  const previous = globalThis.Capacitor;
  globalThis.Capacitor = { Plugins: { MeshWifiDirect: plugin } };
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previous;
  });
}

test('Wi-Fi Direct discovery uses the local selected name and peer identity', async () => {
  const plugin = makePlugin();
  await withPlugin(plugin, async () => {
    const adapter = new WifiDirectAdapter();
    adapter.setIdentity({ peerId: 'a'.repeat(64), fingerprint: 'a'.repeat(64), displayName: 'Phone A' });
    await adapter.startScan();

    assert.equal(plugin.calls[0][0], 'startDiscovery');
    assert.equal(plugin.calls[0][1].displayName, 'Phone A');
    assert.equal(plugin.calls[0][1].fingerprint, 'a'.repeat(64));
  });
});

test('Wi-Fi Direct discovery, connection, and message callbacks report real plugin events', async () => {
  const plugin = makePlugin();
  await withPlugin(plugin, async () => {
    const adapter = new WifiDirectAdapter();
    adapter.setIdentity({ peerId: 'a'.repeat(64), fingerprint: 'a'.repeat(64), displayName: 'Phone A' });
    const messages = [];
    adapter.onMessage((message) => messages.push(message));
    await adapter.startScan();
    plugin.handlers.get('onPeerDiscovered')?.({ deviceAddress: '02:00:00:00:00:01', deviceName: 'Phone B' });
    const connection = await adapter.connect('02:00:00:00:00:01');

    assert.equal(connection.deviceId, 'b'.repeat(64));
    assert.equal(adapter.getPeers().find((peer) => peer.id === connection.deviceId).connected, true);

    const encoded = btoa('encrypted message');
    plugin.handlers.get('onPacketReceived')?.({ deviceId: connection.deviceId, dataBase64: encoded });
    assert.deepEqual(messages, [{ data: 'encrypted message', peerId: connection.deviceId }]);
  });
});

test('Wi-Fi Direct profile name refresh updates the native service record', async () => {
  const plugin = makePlugin();
  await withPlugin(plugin, async () => {
    const adapter = new WifiDirectAdapter();
    adapter.setIdentity({ peerId: 'a'.repeat(64), fingerprint: 'a'.repeat(64), displayName: 'Old name' });
    await adapter.updateDisplayName('New name');
    const call = plugin.calls.find(([name]) => name === 'updateIdentity');
    assert.equal(call[1].displayName, 'New name');
    assert.equal(call[1].fingerprint, 'a'.repeat(64));
  });
});

test('Wi-Fi Direct socket loss updates peer state and notifies disconnect listeners', async () => {
  const plugin = makePlugin();
  await withPlugin(plugin, async () => {
    const adapter = new WifiDirectAdapter();
    await adapter.startScan();
    plugin.handlers.get('onPeerConnected')?.({
      deviceId: 'b'.repeat(64),
      deviceName: 'Phone B',
      fingerprint: 'b'.repeat(64),
      initiated: true
    });
    const disconnected = [];
    adapter.onDisconnect((peerId) => disconnected.push(peerId));
    plugin.handlers.get('onPeerDisconnected')?.({ deviceId: 'b'.repeat(64) });

    assert.deepEqual(disconnected, ['b'.repeat(64)]);
    assert.equal(adapter.getPeers().find((peer) => peer.id === 'b'.repeat(64)).connected, false);
  });
});

test('Wi-Fi Direct packets are sent as bounded base64 over the native socket plugin', async () => {
  const plugin = makePlugin();
  await withPlugin(plugin, async () => {
    const adapter = new WifiDirectAdapter();
    await adapter.send('ciphertext', 'peer-id');
    const call = plugin.calls.find(([name]) => name === 'sendPacket');
    assert.equal(call[1].deviceId, 'peer-id');
    assert.equal(atob(call[1].dataBase64), 'ciphertext');
    await assert.rejects(() => adapter.send('x'.repeat(33_000), 'peer-id'), /size limit/);
  });
});
