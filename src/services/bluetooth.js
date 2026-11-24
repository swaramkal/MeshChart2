import { PacketTransport } from './packet-transport.js';

const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// Smallest frame that fits the default 23-byte ATT MTU (23 - 3 header bytes).
const DEFAULT_FRAME_SIZE = 20;
const MAX_FRAME_SIZE = 255;

export class BluetoothAdapter {
  constructor() {
    this.peers = new Map();
    this.listeners = new Set();
    this.incomingListeners = new Set();
    this.disconnectListeners = new Set();
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.messageHandlers = new Set();
    this.native = null;
    this.nativeBound = false;
    this.advertising = false;
    this.advertisedName = '';
    this.scanning = false;
    this.roles = new Map();
    this.packetTransport = new PacketTransport({ frameSize: DEFAULT_FRAME_SIZE });
    this.sendQueues = new Map();
    this.frameSizes = new Map();
  }

  getNative() {
    return globalThis.Capacitor?.Plugins?.MeshBle || null;
  }

  onPeer(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onIncomingConnection(callback) {
    this.incomingListeners.add(callback);
    return () => this.incomingListeners.delete(callback);
  }

  onDisconnect(callback) {
    this.disconnectListeners.add(callback);
    return () => this.disconnectListeners.delete(callback);
  }

  getPeers() {
    return [...this.peers.values()];
  }

  emit(peer) {
    for (const callback of this.listeners) callback(peer);
  }

  addPeer(peer) {
    this.peers.set(peer.id, {
      ...(this.peers.get(peer.id) || {}),
      ...peer,
      seenAt: Date.now()
    });
    this.emit(this.peers.get(peer.id));
  }

  async bindNativeEvents(native) {
    if (this.nativeBound) return;

    this.native = native;

    await native.addListener('onDeviceDiscovered', event => {
      if (!event?.deviceId) return;

      this.addPeer({
        id: event.deviceId,
        name: event.username || 'MeshPeer',
        rssi: event.rssi,
        native: true
      });
    });

    await native.addListener('onServerPeerConnected', event => {
      const id = event?.deviceId;
      if (!id) return;

      this.roles.set(id, 'server');

      const peer = {
        id,
        name: this.peers.get(id)?.name || 'Nearby MeshChat device',
        native: true,
        connected: true
      };

      this.addPeer(peer);

      for (const callback of this.incomingListeners) {
        callback(peer);
      }
    });

    await native.addListener('onPeerConnected', event => {
      const id = event?.deviceId;
      if (!id) return;

      this.roles.set(id, 'client');

      const peer = this.peers.get(id);
      if (peer) this.addPeer({ ...peer, connected: true });
    });

    await native.addListener('onPeerDisconnected', event => {
      const id = event?.deviceId;
      if (!id) return;

      this.roles.delete(id);
      this.frameSizes.delete(id);

      const peer = this.peers.get(id);
      if (peer) this.addPeer({ ...peer, connected: false });

      for (const callback of this.disconnectListeners) {
        callback(id);
      }
    });

    await native.addListener('onPacketReceived', event => {
      if (!event?.dataBase64) return;

      const peerId = event.deviceId || event.senderId;
      if (!peerId) return;

      try {
        this.receiveFrame(peerId, this.decodeBase64(event.dataBase64));
      } catch (error) {
        console.warn('MeshChat rejected an incoming BLE frame:', error);
      }
    });

    await native.addListener('onScanError', event => {
      console.error('MeshChat BLE scan error:', event);
    });

    await native.addListener('onAdvertiseError', event => {
      console.error('MeshChat BLE advertising error:', event);
    });

    this.nativeBound = true;
  }

  async startScan(displayName = '') {
    const native = this.getNative();

    if (native?.startScan) {
      await this.bindNativeEvents(native);

      // Each phone must advertise as well as scan.
      const safeName = String(displayName || '').trim();
      if (!this.advertising || this.advertisedName !== safeName) {
        await native.startAdvertising({ displayName: safeName });
        this.advertising = true;
        this.advertisedName = safeName;
      }

      await native.startScan({ serviceUuid: SERVICE_UUID });
      this.scanning = true;
      return;
    }

    if (!navigator.bluetooth?.requestDevice) {
      throw new Error(
        'Bluetooth discovery requires the installed Android app with native BLE support.'
      );
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID]
    });

    this.device = device;

    this.addPeer({
      id: device.id,
      name: device.name || 'MeshChat device',
      device
    });

    const deviceId = device.id;

    device.addEventListener('gattserverdisconnected', () => {
      this.server = null;
      this.characteristic = null;

      const currentPeer = this.peers.get(deviceId);
      if (currentPeer) {
        this.addPeer({ ...currentPeer, connected: false });
      }

      for (const callback of this.disconnectListeners) {
        callback(deviceId);
      }
    });
  }

  async updateDisplayName(displayName) {
    const native = this.getNative();
    const safeName = String(displayName || '').trim();
    if (!native?.startAdvertising || !this.advertising) return;

    // Avoid restarting the GATT server while a peer is connected.
    if (this.roles.size > 0) {
      this.advertisedName = '';
      return;
    }

    await native.startAdvertising({ displayName: safeName });
    this.advertisedName = safeName;
  }

  async connect(deviceId) {
    const peer = this.peers.get(deviceId);
    const native = this.getNative();

    if (native && peer?.native) {
      await this.bindNativeEvents(native);

      const result = await native.connect({ deviceId });

      this.roles.set(deviceId, 'client');
      this.addPeer({ ...peer, connected: true });

      return result;
    }

    if (!peer?.device) {
      throw new Error('Select a Bluetooth device discovered in this session.');
    }

    this.server = await peer.device.gatt.connect();

    const service = await this.server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(TX_UUID);

    await this.characteristic.startNotifications();

    this.characteristic.addEventListener(
      'characteristicvaluechanged',
      event => {
        const value = event.target.value;
        const bytes = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength
        );
        this.receiveFrame(deviceId, bytes);
      }
    );

    return true;
  }

  encodeBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  decodeBase64(value) {
    // 255-byte frames encode to 340 Base64 characters.
    if (typeof value !== 'string' || value.length > 400) {
      throw new Error('Invalid BLE Base64 frame.');
    }

    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  receiveFrame(peerId, frame) {
    const packet = this.packetTransport.accept(peerId, frame);
    if (!packet) return false;

    const data = new TextDecoder('utf-8', { fatal: true }).decode(packet);
    this.emitMessage(data, peerId);
    return true;
  }

  emitMessage(data, peerId) {
    for (const callback of this.messageHandlers) {
      try {
        callback({ data, peerId });
      } catch (error) {
        console.error('MeshChat message listener failed:', error);
      }
    }
  }

  onMessage(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Message listener must be a function.');
    }

    this.messageHandlers.add(callback);
    return () => this.messageHandlers.delete(callback);
  }

  // Largest frame the native link can carry for this peer. Falls back to the
  // 20-byte default if the plugin cannot report the negotiated MTU.
  async getFrameSize(native, deviceId, role) {
    const cached = this.frameSizes.get(deviceId);
    if (cached) return cached;

    let size = DEFAULT_FRAME_SIZE;

    try {
      if (typeof native.getMtu === 'function') {
        const result = await native.getMtu({ deviceId, role });
        const payload = Number(result?.maxPayload);

        if (Number.isInteger(payload)) {
          size = Math.min(MAX_FRAME_SIZE, Math.max(DEFAULT_FRAME_SIZE, payload));
        }
      }
    } catch (error) {
      console.warn('MeshChat could not read the BLE MTU:', error);
    }

    // The server-side MTU can still be settling right after connection, so
    // only cache once a larger size has been confirmed.
    if (size > DEFAULT_FRAME_SIZE) this.frameSizes.set(deviceId, size);

    return size;
  }

  async send(data, deviceId) {
    if (typeof data !== 'string' || !data.length) {
      throw new Error('Message data must be a non-empty string.');
    }

    if (!deviceId) {
      throw new Error('A destination peer is required.');
    }

    // Validate size up front so callers get an immediate error.
    this.packetTransport.fragment(data);

    const previous = this.sendQueues.get(deviceId) || Promise.resolve();

    const operation = previous.catch(() => {}).then(async () => {
      const native = this.getNative();

      if (native) {
        const role = this.roles.get(deviceId);

        if (role !== 'client' && role !== 'server') {
          throw new Error('No active BLE connection role for this peer.');
        }

        const method = role === 'client'
          ? native.writePacket
          : native.notifyPacket;

        const frames = this.packetTransport.fragment(
          data,
          await this.getFrameSize(native, deviceId, role)
        );

        if (typeof method !== 'function') {
          throw new Error('Native BLE packet transport is unavailable.');
        }

        for (const frame of frames) {
          await method.call(native, {
            deviceId,
            dataBase64: this.encodeBase64(frame)
          });
        }

        return { fragmentsSent: frames.length };
      }

      if (!this.characteristic) {
        throw new Error('No connected Bluetooth GATT characteristic.');
      }

      const frames = this.packetTransport.fragment(data);
      const service = this.characteristic.service;
      const rx = await service.getCharacteristic(RX_UUID);

      for (const frame of frames) {
        await rx.writeValueWithResponse(frame);
      }

      return { fragmentsSent: frames.length };
    });

    this.sendQueues.set(deviceId, operation);

    try {
      return await operation;
    } finally {
      if (this.sendQueues.get(deviceId) === operation) {
        this.sendQueues.delete(deviceId);
      }
    }
  }

  async stopScan() {
    const native = this.getNative();

    if (native?.stopScan) {
      await native.stopScan();
      this.scanning = false;
    }
  }
}
