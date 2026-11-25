const MAX_PACKET_BYTES = 32 * 1024;
const MAX_BASE64_LENGTH = 44_000;

export class WifiDirectAdapter {
  constructor() {
    this.peers = new Map();
    this.listeners = new Set();
    this.incomingListeners = new Set();
    this.disconnectListeners = new Set();
    this.messageHandlers = new Set();
    this.statusListeners = new Set();
    this.plugin = null;
    this.boundPlugin = null;
    this.listenerHandles = [];
    this.localIdentity = { peerId: '', fingerprint: '', displayName: 'MeshChat' };
    this.deviceAddresses = new Map();
    this.pendingDeviceId = null;
  }

  getNative() {
    return globalThis.Capacitor?.Plugins?.MeshWifiDirect || null;
  }

  setIdentity({ peerId, fingerprint, displayName } = {}) {
    this.localIdentity = {
      peerId: String(peerId || fingerprint || ''),
      fingerprint: String(fingerprint || ''),
      displayName: String(displayName || 'MeshChat').trim().slice(0, 32) || 'MeshChat'
    };
  }

  onPeer(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onIncomingConnection(callback) { this.incomingListeners.add(callback); return () => this.incomingListeners.delete(callback); }
  onDisconnect(callback) { this.disconnectListeners.add(callback); return () => this.disconnectListeners.delete(callback); }
  onMessage(callback) { this.messageHandlers.add(callback); return () => this.messageHandlers.delete(callback); }
  onStatus(callback) { this.statusListeners.add(callback); return () => this.statusListeners.delete(callback); }

  getPeers() { return [...this.peers.values()]; }
  getStatus() {
    const native = this.getNative();
    return native?.getStatus ? native.getStatus() : Promise.resolve({
      supported: false,
      available: false,
      state: 'native-adapter-required',
      detail: 'Wi-Fi Direct requires the installed Android app.'
    });
  }

  emitPeer(peer) {
    for (const callback of this.listeners) callback(peer);
  }

  addPeer(peer) {
    const previous = this.peers.get(peer.id) || {};
    const next = { ...previous, ...peer, transport: 'wifi-direct', seenAt: Date.now() };
    this.peers.set(next.id, next);
    this.emitPeer(next);
    return next;
  }

  async bindNativeEvents(native) {
    if (this.boundPlugin === native) return;
    this.plugin = native;

    const bind = async (event, callback) => {
      const handle = await native.addListener(event, callback);
      this.listenerHandles.push(handle);
    };

    await bind('onPeerDiscovered', (event) => {
      if (!event?.deviceAddress) return;
      this.addPeer({
        id: event.deviceAddress,
        deviceAddress: event.deviceAddress,
        name: event.deviceName || 'Nearby Wi-Fi Direct device',
        connected: false,
        identityFingerprintHint: ''
      });
    });

    await bind('onPeerConnected', (event) => {
      if (!event?.deviceId) return;
      const id = String(event.deviceId);
      const address = this.pendingDeviceId;
      if (address) {
        this.deviceAddresses.set(id, address);
        this.peers.delete(address);
      }
      const peer = this.addPeer({
        id,
        deviceAddress: address || this.deviceAddresses.get(id) || '',
        name: event.deviceName || this.peers.get(id)?.name || 'Nearby MeshChat device',
        identityFingerprintHint: event.fingerprint || '',
        connected: true,
        native: true
      });
      this.pendingDeviceId = null;
      if (!event.initiated) {
        for (const callback of this.incomingListeners) callback(peer);
      }
    });

    await bind('onPeerDisconnected', (event) => {
      if (!event?.deviceId) return;
      const peer = this.peers.get(event.deviceId);
      if (peer) this.addPeer({ ...peer, connected: false });
      for (const callback of this.disconnectListeners) callback(event.deviceId);
    });

    await bind('onPacketReceived', (event) => {
      if (typeof event?.dataBase64 !== 'string' || !event.deviceId) return;
      try {
        const data = this.decodeBase64(event.dataBase64);
        for (const callback of this.messageHandlers) callback({ data, peerId: event.deviceId });
      } catch (error) {
        console.warn('MeshChat rejected an incoming Wi-Fi Direct packet:', error);
      }
    });

    await bind('onStatus', (event) => {
      for (const callback of this.statusListeners) callback(event);
    });

    await bind('onError', (event) => {
      for (const callback of this.statusListeners) callback({ ...event, error: true });
    });

    this.boundPlugin = native;
  }

  async startScan() {
    const native = this.getNative();
    if (!native?.startDiscovery) {
      throw new Error('Wi-Fi Direct discovery requires the installed Android app.');
    }
    await this.bindNativeEvents(native);
    await native.startDiscovery(this.localIdentity);
  }

  async stopScan() {
    const native = this.getNative();
    if (native?.stopDiscovery) await native.stopDiscovery();
  }

  async updateDisplayName(displayName) {
    this.localIdentity.displayName = String(displayName || 'MeshChat').trim().slice(0, 32) || 'MeshChat';
    const native = this.getNative();
    if (native?.updateIdentity) {
      await native.updateIdentity(this.localIdentity);
    }
  }

  async connect(deviceId) {
    const native = this.getNative();
    if (!native?.connect) throw new Error('Native Wi-Fi Direct transport is unavailable.');
    await this.bindNativeEvents(native);
    const peer = this.peers.get(deviceId);
    const address = peer?.deviceAddress || this.deviceAddresses.get(deviceId) || deviceId;
    this.pendingDeviceId = address;
    try {
      const result = await native.connect({
        deviceAddress: address,
        ...this.localIdentity
      });
      const id = result?.deviceId || deviceId;
      this.deviceAddresses.set(id, address);
      const connected = this.addPeer({
        id,
        deviceAddress: address,
        name: result?.deviceName || peer?.name || 'Nearby MeshChat device',
        identityFingerprintHint: result?.fingerprint || '',
        connected: true,
        native: true
      });
      this.pendingDeviceId = null;
      return { ...result, deviceId: id, deviceName: connected.name };
    } catch (error) {
      this.pendingDeviceId = null;
      throw error;
    }
  }

  encodeBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  decodeBase64(value) {
    if (typeof value !== 'string' || value.length > MAX_BASE64_LENGTH) {
      throw new Error('Invalid Wi-Fi Direct packet encoding.');
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    if (bytes.length < 1 || bytes.length > MAX_PACKET_BYTES) throw new Error('Wi-Fi Direct packet exceeds the size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async send(data, deviceId) {
    if (typeof data !== 'string' || data.length === 0) throw new Error('Packet data must be a non-empty string.');
    const bytes = new TextEncoder().encode(data);
    if (bytes.length > MAX_PACKET_BYTES) throw new Error('Packet exceeds the Wi-Fi Direct size limit.');
    const native = this.getNative();
    if (!native?.sendPacket) throw new Error('Native Wi-Fi Direct packet transport is unavailable.');
    await this.bindNativeEvents(native);
    await native.sendPacket({ deviceId, dataBase64: this.encodeBase64(data) });
    return { bytesSent: bytes.length };
  }

  async disconnect(deviceId) {
    const native = this.getNative();
    if (native?.disconnect) await native.disconnect({ deviceId });
    const peer = this.peers.get(deviceId);
    if (peer) this.addPeer({ ...peer, connected: false });
  }

  async destroy() {
    for (const handle of this.listenerHandles.splice(0)) {
      try { await handle.remove?.(); } catch {}
    }
    this.boundPlugin = null;
    this.plugin = null;
  }
}
