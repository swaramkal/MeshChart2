const TRANSPORT_PRIORITY = ['wifi-direct', 'bluetooth'];
const RECONNECT_DELAYS = [500, 1500, 4000];

export class TransportManager {
  constructor({ bluetooth, wifiDirect, reconnectDelays = RECONNECT_DELAYS } = {}) {
    if (!bluetooth || !wifiDirect) throw new Error('Bluetooth and Wi-Fi Direct adapters are required.');
    this.adapters = new Map([
      ['bluetooth', bluetooth],
      ['wifi-direct', wifiDirect]
    ]);
    this.reconnectDelays = reconnectDelays;
    this.peersByTransport = new Map([...this.adapters.keys()].map((key) => [key, new Map()]));
    this.connected = new Map();
    this.intentionalDisconnects = new Set();
    this.reconnectTargets = new Map();
    this.reconnectTimers = new Map();
    this.identityByPeer = new Map();
    this.trustedFingerprints = new Set();
    this.messageListeners = new Set();
    this.peerListeners = new Set();
    this.incomingListeners = new Set();
    this.disconnectListeners = new Set();
    this.statusListeners = new Set();
    this.bindAdapters();
  }

  bindAdapters() {
    for (const [transport, adapter] of this.adapters) {
      adapter.onPeer?.((peer) => this.updatePeer(transport, peer));
      adapter.onIncomingConnection?.((peer) => {
        const normalized = this.updatePeer(transport, peer);
        for (const callback of this.incomingListeners) callback(normalized);
      });
      adapter.onMessage?.((message) => {
        for (const callback of this.messageListeners) callback({ ...message, transport });
      });
      adapter.onDisconnect?.((peerId) => this.handleDisconnect(transport, peerId));
      adapter.onStatus?.((status) => {
        for (const callback of this.statusListeners) callback({ transport, ...status });
      });
    }
  }

  updatePeer(transport, peer) {
    if (!peer?.id) return null;
    const peers = this.peersByTransport.get(transport);
    const next = { ...(peers.get(peer.id) || {}), ...peer, id: String(peer.id), transport };
    peers.set(next.id, next);
    if (next.connected) this.markConnected(transport, next.id);
    this.emitPeers();
    return next;
  }

  emitPeers() {
    const peers = this.getPeers();
    for (const callback of this.peerListeners) callback(peers);
  }

  getPeers() {
    const combined = new Map();
    for (const [transport, peers] of this.peersByTransport) {
      for (const peer of peers.values()) {
        const existing = combined.get(peer.id);
        const transports = [...new Set([...(existing?.transports || []), transport])];
        combined.set(peer.id, { ...existing, ...peer, transports });
      }
    }
    return [...combined.values()];
  }

  onPeer(callback) { this.peerListeners.add(callback); return () => this.peerListeners.delete(callback); }
  onIncomingConnection(callback) { this.incomingListeners.add(callback); return () => this.incomingListeners.delete(callback); }
  onDisconnect(callback) { this.disconnectListeners.add(callback); return () => this.disconnectListeners.delete(callback); }
  onMessage(callback) {
    if (typeof callback !== 'function') throw new TypeError('Message listener must be a function.');
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }
  onStatus(callback) { this.statusListeners.add(callback); return () => this.statusListeners.delete(callback); }

  setIdentity(identity) {
    for (const adapter of this.adapters.values()) adapter.setIdentity?.(identity);
  }

  associateIdentity(peerId, fingerprint) {
    if (!peerId || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) return;
    this.identityByPeer.set(String(peerId), fingerprint.toLowerCase());
    this.trustedFingerprints.add(fingerprint.toLowerCase());
    this.peersByTransport.get('wifi-direct')?.forEach((peer, id) => {
      if (peer.identityFingerprintHint?.toLowerCase() === fingerprint.toLowerCase()) {
        this.identityByPeer.set(id, fingerprint.toLowerCase());
      }
    });
  }

  getPeerFingerprint(peerId) {
    return this.identityByPeer.get(String(peerId)) || null;
  }

  getConnectionType(peerId) {
    return this.connectedCandidates(peerId)[0]?.transport || null;
  }

  peerIdsFor(peerId) {
    const ids = new Set([String(peerId)]);
    const fingerprint = this.getPeerFingerprint(peerId);
    if (!fingerprint) return [...ids];
    for (const [id, mapped] of this.identityByPeer) {
      if (mapped === fingerprint) ids.add(id);
    }
    for (const [id, peer] of this.peersByTransport.get('wifi-direct') || []) {
      if (peer.identityFingerprintHint?.toLowerCase() === fingerprint && this.trustedFingerprints.has(fingerprint)) ids.add(id);
    }
    return [...ids];
  }

  markConnected(transport, peerId) {
    const key = String(peerId);
    const transports = this.connected.get(key) || new Set();
    transports.add(transport);
    this.connected.set(key, transports);
    this.clearReconnect(key);
  }

  async startScan(displayName) {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.startScan(displayName))
    );
    const successes = results.filter((result) => result.status === 'fulfilled');
    if (successes.length === 0) {
      const error = results.find((result) => result.status === 'rejected')?.reason;
      throw error || new Error('No nearby transport is available.');
    }
    return { activeTransports: successes.length };
  }

  async stopScan() {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.stopScan?.())
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async updateDisplayName(displayName) {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.updateDisplayName?.(displayName))
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async getStatus() {
    const statuses = await Promise.all([...this.adapters].map(async ([transport, adapter]) => {
      if (adapter.getStatus) {
        try { return [transport, await adapter.getStatus()]; }
        catch (error) { return [transport, { available: false, state: 'error', detail: error.message }]; }
      }
      return [transport, { available: Boolean(adapter.getNative?.()), state: 'adapter-present' }];
    }));
    return Object.fromEntries(statuses);
  }

  candidatesFor(peerId, preferredTransport) {
    const ids = this.peerIdsFor(peerId);
    const candidates = [];
    for (const id of ids) {
      for (const [transport, peers] of this.peersByTransport) {
        const peer = peers.get(id);
        if (!peer || !this.adapters.get(transport)?.connect) continue;
        candidates.push({ transport, id, peer });
      }
    }
    return candidates.sort((a, b) => {
      if (a.transport === preferredTransport) return -1;
      if (b.transport === preferredTransport) return 1;
      return TRANSPORT_PRIORITY.indexOf(a.transport) - TRANSPORT_PRIORITY.indexOf(b.transport);
    });
  }

  async connect(peerId, preferredTransport) {
    const candidates = this.candidatesFor(peerId, preferredTransport);
    if (!candidates.length) throw new Error('This nearby peer is no longer available. Scan again and retry.');
    const failures = [];
    for (const candidate of candidates) {
      try {
        const result = await this.adapters.get(candidate.transport).connect(candidate.id, candidate.peer);
        const connectedId = String(result?.deviceId || candidate.id);
        this.updatePeer(candidate.transport, {
          ...candidate.peer,
          id: connectedId,
          name: result?.deviceName || candidate.peer.name,
          connected: true
        });
        this.markConnected(candidate.transport, connectedId);
        this.reconnectTargets.set(connectedId, {
          transport: candidate.transport,
          peerId: connectedId,
          peer: { ...candidate.peer, id: connectedId }
        });
        return { ...result, deviceId: connectedId, transport: candidate.transport };
      } catch (error) {
        failures.push(`${candidate.transport}: ${error.message || 'connection failed'}`);
      }
    }
    throw new Error(failures.join('; ') || 'Unable to connect over available transports.');
  }

  connectedCandidates(peerId) {
    const ids = this.peerIdsFor(peerId);
    const candidates = [];
    for (const id of ids) {
      for (const transport of this.connected.get(id) || []) {
        const adapter = this.adapters.get(transport);
        if (adapter) candidates.push({ id, transport, adapter });
      }
    }
    return candidates.sort((a, b) => TRANSPORT_PRIORITY.indexOf(a.transport) - TRANSPORT_PRIORITY.indexOf(b.transport));
  }

  async send(data, peerId) {
    const candidates = this.connectedCandidates(peerId);
    if (!candidates.length) throw new Error('No active nearby transport for this peer.');
    const failures = [];
    for (const candidate of candidates) {
      try {
        return { ...(await candidate.adapter.send(data, candidate.id)), transport: candidate.transport };
      } catch (error) {
        failures.push(`${candidate.transport}: ${error.message || 'send failed'}`);
        this.connected.get(candidate.id)?.delete(candidate.transport);
      }
    }
    throw new Error(failures.join('; ') || 'All connected transports failed.');
  }

  async disconnect(peerId) {
    const targets = this.connectedCandidates(peerId);
    for (const target of targets) {
      const key = `${target.transport}:${target.id}`;
      this.intentionalDisconnects.add(key);
      try { await target.adapter.disconnect?.(target.id); } finally {
        this.connected.get(target.id)?.delete(target.transport);
        this.intentionalDisconnects.delete(key);
      }
    }
    this.reconnectTargets.delete(String(peerId));
    this.clearReconnect(String(peerId));
  }

  handleDisconnect(transport, peerId) {
    const id = String(peerId);
    this.connected.get(id)?.delete(transport);
    const peer = this.peersByTransport.get(transport)?.get(id);
    if (peer) this.updatePeer(transport, { ...peer, connected: false });
    if (this.connectedCandidates(id).length) return;
    const intentional = this.intentionalDisconnects.has(`${transport}:${id}`);
    if (!intentional) {
      for (const callback of this.disconnectListeners) callback(id);
      this.scheduleReconnect(id);
    }
  }

  scheduleReconnect(peerId, attempt = 0) {
    const target = this.reconnectTargets.get(String(peerId));
    if (!target || attempt >= this.reconnectDelays.length) return;
    this.clearReconnect(peerId);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(String(peerId));
      if (!this.reconnectTargets.has(String(peerId))) return;
      try {
        const result = await this.adapters.get(target.transport).connect(target.peerId, target.peer);
        this.markConnected(target.transport, result?.deviceId || target.peerId);
      } catch {
        this.scheduleReconnect(peerId, attempt + 1);
      }
    }, this.reconnectDelays[attempt]);
    this.reconnectTimers.set(String(peerId), timer);
  }

  clearReconnect(peerId) {
    const key = String(peerId);
    const timer = this.reconnectTimers.get(key);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(key);
  }

  async destroy() {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.destroy?.()));
  }
}
