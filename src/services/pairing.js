import { CryptoService } from './crypto.js';

// Protocol v2: every pairing is bound to each device's long-term identity key.
// The first pairing with a device needs a human-verified code. After that the
// identity is pinned, so a reconnect from a new Bluetooth address is
// recognised cryptographically and confirmed without comparing a code again.
const VERSION = 2;
const TIMEOUT_MS = 60000;
const MAX_PACKET_LENGTH = 3000;
const MAX_IDENTITY_KEY_LENGTH = 512;

function randomHex(bytes = 16) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map(value => value.toString(16).padStart(2, '0')).join('');
}

function validHex(value, length = 32) {
  return typeof value === 'string' &&
    value.length === length &&
    /^[0-9a-f]+$/i.test(value);
}

function validIdentityKey(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_KEY_LENGTH;
}

function makeTranscript(session) {
  return JSON.stringify([
    'MeshChat Pairing v2',
    session.sessionId,
    session.initiatorPublicKey,
    session.initiatorNonce,
    session.responderPublicKey,
    session.responderNonce,
    session.initiatorIdentityKey,
    session.responderIdentityKey
  ]);
}

export class PairingController {
  constructor(
    bluetooth,
    {
      onState = () => {},
      onSecure = () => {},
      getIdentity,
      findTrusted = async () => null
    } = {}
  ) {
    if (typeof getIdentity !== 'function') {
      throw new Error('A local identity provider is required for pairing.');
    }

    this.bluetooth = bluetooth;
    this.onState = onState;
    this.onSecure = onSecure;
    this.getIdentity = getIdentity;
    this.findTrusted = findTrusted;
    this.sessions = new Map();
    this.secureSessions = new Map();

    this.removeMessageListener = this.bluetooth.onMessage(({ data, peerId }) => {
      return this.handleMessage(data, peerId).catch(error => {
        console.warn('MeshChat pairing packet rejected:', error);
      });
    });

    this.removeDisconnectListener = this.bluetooth.onDisconnect(peerId => {
      this.cancel(peerId, 'disconnected', false);
    });
  }

  isCurrent(session) {
    return this.sessions.get(session.peerId) === session;
  }

  publish(session, status) {
    session.status = status;

    this.onState({
      peerId: session.peerId,
      peerName: session.peerName,
      role: session.role,
      status,
      trusted: Boolean(session.trusted),
      verificationCode: session.material?.verificationCode || null
    });
  }

  armTimeout(session) {
    clearTimeout(session.timer);

    session.timer = setTimeout(() => {
      if (this.sessions.get(session.peerId) === session) {
        this.cancel(session.peerId, 'timeout', true);
      }
    }, TIMEOUT_MS);
  }

  async send(peerId, packet) {
    const encoded = JSON.stringify(packet);

    if (encoded.length > MAX_PACKET_LENGTH) {
      throw new Error('Pairing packet exceeds the allowed size.');
    }

    await this.bluetooth.send(encoded, peerId);
  }

  async start(peerId, peerName = 'Nearby device') {
    if (!peerId) throw new Error('A peer is required for pairing.');

    if (this.secureSessions.has(peerId)) {
      throw new Error('This peer already has a secure session.');
    }

    if (this.sessions.has(peerId)) {
      this.cancel(peerId, 'restarted', true);
    }

    const session = {
      peerId,
      peerName,
      role: 'initiator',
      sessionId: randomHex(),
      localNonce: randomHex(),
      crypto: new CryptoService(),
      material: null,
      localConfirmed: false,
      remoteConfirmed: false,
      trusted: false,
      timer: null
    };

    this.sessions.set(peerId, session);
    this.armTimeout(session);
    this.publish(session, 'negotiating');

    try {
      const identity = await session.crypto.createIdentity();
      const local = await this.getIdentity();

      if (!this.isCurrent(session)) {
        session.crypto.clearIdentity();
        return false;
      }

      session.identity = local;
      session.localPublicKey = identity.publicKey;

      await this.send(peerId, {
        v: VERSION,
        type: 'hello',
        sessionId: session.sessionId,
        nonce: session.localNonce,
        publicKey: identity.publicKey,
        identityKey: local.publicKeySpki
      });
    } catch (error) {
      if (this.isCurrent(session)) {
        this.cancel(peerId, 'failed', true);
      }
      throw error;
    }

    return true;
  }

  async handleMessage(data, peerId) {
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length > MAX_PACKET_LENGTH ||
      !peerId
    ) {
      return;
    }

    let packet;

    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }

    if (!packet || packet.v !== VERSION || typeof packet.type !== 'string') {
      return;
    }

    if (packet.type === 'hello') {
      await this.receiveHello(peerId, packet);
      return;
    }

    const session = this.sessions.get(peerId);

    if (!session || packet.sessionId !== session.sessionId) return;

    if (packet.type === 'ack') {
      await this.receiveAck(session, packet);
    } else if (packet.type === 'confirm') {
      await this.receiveConfirmation(session, packet);
    } else if (packet.type === 'cancel') {
      this.cancel(peerId, 'peer-cancelled', false);
    }
  }

  async receiveHello(peerId, packet) {
    if (
      !validHex(packet.sessionId) ||
      !validHex(packet.nonce) ||
      typeof packet.publicKey !== 'string' ||
      packet.publicKey.length > 4096 ||
      !validIdentityKey(packet.identityKey)
    ) {
      return;
    }

    const existing = this.sessions.get(peerId);

    if (existing) {
      if (existing.role !== 'initiator') return;

      // Deterministic collision handling: the lexicographically smaller
      // session ID becomes the winning initiator on both devices.
      if (existing.sessionId.toLowerCase() < packet.sessionId.toLowerCase()) {
        return;
      }

      this.discard(existing);
    }

    const session = {
      peerId,
      peerName: this.bluetooth.peers.get(peerId)?.name || 'Nearby device',
      role: 'responder',
      sessionId: packet.sessionId,
      remoteNonce: packet.nonce,
      remotePublicKey: packet.publicKey,
      remoteIdentityKey: packet.identityKey,
      crypto: new CryptoService(),
      material: null,
      localConfirmed: false,
      remoteConfirmed: false,
      trusted: false,
      timer: null
    };

    this.sessions.set(peerId, session);
    this.armTimeout(session);
    this.publish(session, 'negotiating');

    try {
      const identity = await session.crypto.createIdentity();
      const local = await this.getIdentity();

      if (!this.isCurrent(session)) {
        session.crypto.clearIdentity();
        return;
      }

      if (local.publicKeySpki === packet.identityKey) {
        throw new Error('Refusing to pair a device with itself.');
      }

      session.identity = local;
      session.localPublicKey = identity.publicKey;
      session.localNonce = randomHex();

      session.initiatorPublicKey = packet.publicKey;
      session.initiatorNonce = packet.nonce;
      session.initiatorIdentityKey = packet.identityKey;
      session.responderPublicKey = identity.publicKey;
      session.responderNonce = session.localNonce;
      session.responderIdentityKey = local.publicKeySpki;

      session.material = await session.crypto.derivePairingMaterial(
        packet.publicKey,
        makeTranscript(session)
      );

      if (!this.isCurrent(session)) {
        session.crypto.clearIdentity();
        return;
      }

      await this.send(peerId, {
        v: VERSION,
        type: 'ack',
        sessionId: session.sessionId,
        nonce: session.localNonce,
        publicKey: identity.publicKey,
        identityKey: local.publicKeySpki
      });

      await this.materialReady(session);
    } catch (error) {
      if (this.isCurrent(session)) {
        this.cancel(peerId, 'failed', true);
      }
      throw error;
    }
  }

  async receiveAck(session, packet) {
    if (
      session.role !== 'initiator' ||
      session.material ||
      session.ackReceived ||
      !validHex(packet.nonce) ||
      typeof packet.publicKey !== 'string' ||
      packet.publicKey.length > 4096 ||
      !validIdentityKey(packet.identityKey)
    ) {
      return;
    }

    session.ackReceived = true;

    try {
      if (session.identity.publicKeySpki === packet.identityKey) {
        throw new Error('Refusing to pair a device with itself.');
      }

      session.remoteIdentityKey = packet.identityKey;
      session.initiatorPublicKey = session.localPublicKey;
      session.initiatorNonce = session.localNonce;
      session.initiatorIdentityKey = session.identity.publicKeySpki;
      session.responderPublicKey = packet.publicKey;
      session.responderNonce = packet.nonce;
      session.responderIdentityKey = packet.identityKey;

      session.material = await session.crypto.derivePairingMaterial(
        packet.publicKey,
        makeTranscript(session)
      );

      if (!this.isCurrent(session)) {
        session.crypto.clearIdentity();
        return;
      }

      await this.materialReady(session);
    } catch (error) {
      if (this.isCurrent(session)) {
        this.cancel(session.peerId, 'failed', true);
      }
      throw error;
    }
  }

  // Called once both sides' keys are known. Looks the remote identity up in
  // the pinned contacts, processes any confirmation that arrived early, and
  // confirms automatically for a recognised contact.
  async materialReady(session) {
    session.remoteFingerprint =
      await session.crypto.fingerprintOf(session.remoteIdentityKey);

    const contact = await this.findTrusted(session.remoteFingerprint);

    if (!this.isCurrent(session)) return;

    session.trusted = Boolean(contact);
    this.publish(session, 'awaiting-confirmation');

    // The peer may confirm before our own key derivation finished, because
    // BLE packets are handled concurrently.
    if (session.pendingConfirmation) {
      const early = session.pendingConfirmation;
      session.pendingConfirmation = null;
      await this.receiveConfirmation(session, early);
      if (!this.isCurrent(session)) return;
    }

    if (session.trusted) {
      await this.confirmLocal(session.peerId);
    }
  }

  async confirmLocal(peerId) {
    const session = this.sessions.get(peerId);

    if (!session || !session.material) {
      throw new Error('Pairing is not ready for confirmation.');
    }

    if (session.localConfirmed || session.localConfirming) return;

    session.localConfirming = true;
    session.localConfirmed = true;

    try {
      const mac = await session.crypto.createConfirmationMac(
        session.material.confirmationKey,
        session.role,
        session.material.transcriptHash
      );

      const signature = await session.crypto.signIdentityConfirmation(
        session.identity.privateKey,
        session.role,
        session.material.transcriptHash
      );

      if (!this.isCurrent(session)) return;

      await this.send(peerId, {
        v: VERSION,
        type: 'confirm',
        sessionId: session.sessionId,
        role: session.role,
        mac,
        signature
      });

      if (!this.isCurrent(session)) return;

      session.localConfirming = false;
      this.publish(session, 'awaiting-peer-confirmation');
      await this.completeIfReady(session);
    } catch (error) {
      if (this.isCurrent(session)) {
        this.cancel(peerId, 'failed', true);
      }
      throw error;
    }
  }

  async receiveConfirmation(session, packet) {
    if (
      !['initiator', 'responder'].includes(packet.role) ||
      packet.role === session.role ||
      typeof packet.mac !== 'string' ||
      typeof packet.signature !== 'string'
    ) {
      return;
    }

    if (!session.material) {
      session.pendingConfirmation = packet;
      return;
    }

    const macValid = await session.crypto.verifyConfirmationMac(
      session.material.confirmationKey,
      packet.role,
      session.material.transcriptHash,
      packet.mac
    );

    const identityValid = macValid &&
      await session.crypto.verifyIdentityConfirmation(
        session.remoteIdentityKey,
        packet.role,
        session.material.transcriptHash,
        packet.signature
      );

    if (!this.isCurrent(session)) return;

    if (!macValid || !identityValid) {
      this.cancel(session.peerId, 'verification-failed', true);
      return;
    }

    session.remoteConfirmed = true;
    await this.completeIfReady(session);
  }

  async completeIfReady(session) {
    if (!session.localConfirmed || !session.remoteConfirmed) return;
    if (this.sessions.get(session.peerId) !== session) return;

    clearTimeout(session.timer);

    const secureSession = {
      sessionId: session.sessionId,
      role: session.role,
      encryptionKey: session.material.encryptionKey,
      remoteFingerprint: session.remoteFingerprint,
      wasTrusted: session.trusted,
      establishedAt: Date.now(),
      peerName: session.peerName,
      sendCounter: 0,
      receiveHighest: 0,
      receiveSeen: new Set()
    };

    this.secureSessions.set(session.peerId, secureSession);
    this.sessions.delete(session.peerId);
    session.crypto.clearIdentity();

    this.onState({
      peerId: session.peerId,
      peerName: session.peerName,
      role: session.role,
      status: 'secure',
      trusted: session.trusted,
      verificationCode: session.material.verificationCode
    });

    await this.onSecure(session.peerId, secureSession);
  }

  discard(session) {
    clearTimeout(session.timer);
    session.crypto?.clearIdentity();

    if (this.sessions.get(session.peerId) === session) {
      this.sessions.delete(session.peerId);
    }
  }

  cancel(peerId, status = 'cancelled', notifyPeer = true) {
    const session = this.sessions.get(peerId);
    const hadSecure = this.secureSessions.has(peerId);

    if (session) {
      if (notifyPeer) {
        this.send(peerId, {
          v: VERSION,
          type: 'cancel',
          sessionId: session.sessionId
        }).catch(() => {});
      }

      this.discard(session);
    }

    this.secureSessions.delete(peerId);

    // Do not raise pairing UI for a Bluetooth peer that was never pairing.
    if (session || hadSecure) {
      this.onState({ peerId, status, trusted: false, verificationCode: null });
    }
  }

  getSecureSession(peerId) {
    return this.secureSessions.get(peerId) || null;
  }

  isSecure(peerId) {
    return this.secureSessions.has(peerId);
  }

  // Forget every session, e.g. after the user clears local data.
  reset() {
    for (const peerId of [...this.sessions.keys()]) {
      this.cancel(peerId, 'destroyed', true);
    }

    this.secureSessions.clear();
  }

  destroy() {
    this.removeMessageListener?.();
    this.removeDisconnectListener?.();

    for (const peerId of [...this.sessions.keys()]) {
      this.cancel(peerId, 'destroyed', false);
    }

    this.secureSessions.clear();
  }
}
