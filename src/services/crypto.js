const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PROTOCOL_INFO = encoder.encode('MeshChat Secure Pairing v1');
const CONFIRM_PREFIX = 'MeshChat pairing confirmation v1';
const SAS_PREFIX = 'MeshChat verification code v1';
const IDENTITY_SIGNATURE_PREFIX = 'MeshChat identity confirmation v2';

// Groups a hex fingerprint for display, e.g. "a1b2 c3d4 e5f6 ...".
export function formatFingerprint(fingerprint, groups = 8) {
  if (typeof fingerprint !== 'string') return '';
  return (fingerprint.match(/.{1,4}/g) || []).slice(0, groups).join(' ');
}

export class CryptoService {
  constructor() {
    this.keyPair = null;
  }

  supported() {
    return Boolean(
      globalThis.crypto?.subtle &&
      globalThis.crypto?.getRandomValues
    );
  }

  async createIdentity() {
    if (!this.supported()) {
      throw new Error(
        'Web Crypto is unavailable. Use HTTPS or the Android application.'
      );
    }

    this.keyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      false,
      ['deriveBits']
    );

    const publicKey = await crypto.subtle.exportKey(
      'spki',
      this.keyPair.publicKey
    );

    return {
      algorithm: 'ECDH-P256',
      publicKey: this.toBase64(publicKey)
    };
  }

  async importPeerPublicKey(encoded) {
    if (typeof encoded !== 'string' || encoded.length > 4096) {
      throw new Error('Invalid peer public key.');
    }

    const bytes = this.fromBase64(encoded);

    return crypto.subtle.importKey(
      'spki',
      bytes,
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      false,
      []
    );
  }

  async derivePairingMaterial(peerPublicKey, transcript) {
    if (!this.keyPair) {
      throw new Error('Create a local identity before pairing.');
    }

    if (
      typeof transcript !== 'string' ||
      transcript.length < 1 ||
      transcript.length > 12000
    ) {
      throw new Error('Invalid pairing transcript.');
    }

    const peer = await this.importPeerPublicKey(peerPublicKey);

    const sharedSecret = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: peer
      },
      this.keyPair.privateKey,
      256
    );

    const transcriptBytes = encoder.encode(transcript);

    const transcriptHash = await crypto.subtle.digest(
      'SHA-256',
      transcriptBytes
    );

    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret,
      'HKDF',
      false,
      ['deriveBits']
    );

    const derived = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: transcriptHash,
        info: PROTOCOL_INFO
      },
      hkdfKey,
      768
    );

    const material = new Uint8Array(derived);

    const encryptionBytes = material.slice(0, 32);
    const confirmationBytes = material.slice(32, 64);
    const sasBytes = material.slice(64, 96);

    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      encryptionBytes,
      {
        name: 'AES-GCM',
        length: 256
      },
      false,
      ['encrypt', 'decrypt']
    );

    const confirmationKey = await crypto.subtle.importKey(
      'raw',
      confirmationBytes,
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      false,
      ['sign', 'verify']
    );

    const sasKey = await crypto.subtle.importKey(
      'raw',
      sasBytes,
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );

    const sasInput = encoder.encode(
      `${SAS_PREFIX}|${this.toBase64(transcriptHash)}`
    );

    const sasDigest = new Uint8Array(
      await crypto.subtle.sign('HMAC', sasKey, sasInput)
    );

    const number =
      new DataView(
        sasDigest.buffer,
        sasDigest.byteOffset,
        sasDigest.byteLength
      ).getUint32(0, false) % 1000000;

    return {
      encryptionKey,
      confirmationKey,
      verificationCode: String(number).padStart(6, '0'),
      transcriptHash: this.toBase64(transcriptHash)
    };
  }

  async createConfirmationMac(confirmationKey, role, transcriptHash) {
    if (!['initiator', 'responder'].includes(role)) {
      throw new Error('Invalid pairing role.');
    }

    if (typeof transcriptHash !== 'string' || transcriptHash.length > 256) {
      throw new Error('Invalid transcript hash.');
    }

    const message = encoder.encode(
      `${CONFIRM_PREFIX}|${role}|${transcriptHash}`
    );

    const signature = await crypto.subtle.sign(
      'HMAC',
      confirmationKey,
      message
    );

    return this.toBase64(signature);
  }

  async verifyConfirmationMac(
    confirmationKey,
    role,
    transcriptHash,
    encodedMac
  ) {
    if (!['initiator', 'responder'].includes(role)) {
      return false;
    }

    try {
      if (
        typeof transcriptHash !== 'string' ||
        typeof encodedMac !== 'string' ||
        encodedMac.length > 256
      ) {
        return false;
      }

      const message = encoder.encode(
        `${CONFIRM_PREFIX}|${role}|${transcriptHash}`
      );

      return await crypto.subtle.verify(
        'HMAC',
        confirmationKey,
        this.fromBase64(encodedMac),
        message
      );
    } catch {
      return false;
    }
  }

  async encrypt(key, plaintext, additionalData = '') {
    if (typeof plaintext !== 'string') {
      throw new Error('Plaintext must be a string.');
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encoder.encode(additionalData)
      },
      key,
      encoder.encode(plaintext)
    );

    return {
      algorithm: 'AES-256-GCM',
      iv: this.toBase64(iv),
      ciphertext: this.toBase64(ciphertext)
    };
  }

  async decrypt(key, envelope, additionalData = '') {
    if (envelope?.algorithm !== 'AES-256-GCM') {
      throw new Error('Unsupported encrypted message format.');
    }

    const iv = this.fromBase64(envelope.iv);

    if (iv.length !== 12) {
      throw new Error('Invalid AES-GCM initialization vector.');
    }

    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encoder.encode(additionalData)
      },
      key,
      this.fromBase64(envelope.ciphertext)
    );

    return decoder.decode(plaintext);
  }

  // ---- Long-term device identity (ECDSA P-256) ----------------------------
  // The identity key survives restarts and Bluetooth address changes. It is
  // used to sign each pairing transcript so a known contact can be recognised
  // without comparing a code again. The private key is non-extractable.

  async createSigningIdentity() {
    if (!this.supported()) {
      throw new Error(
        'Web Crypto is unavailable. Use HTTPS or the Android application.'
      );
    }

    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );

    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);

    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeySpki: this.toBase64(spki)
    };
  }

  async fingerprintOf(publicKeySpki) {
    const bytes = this.fromBase64(publicKeySpki);
    const digest = await crypto.subtle.digest('SHA-256', bytes);

    return [...new Uint8Array(digest)]
      .map(value => value.toString(16).padStart(2, '0'))
      .join('');
  }

  identityMessage(role, transcriptHash) {
    if (!['initiator', 'responder'].includes(role)) {
      throw new Error('Invalid pairing role.');
    }

    if (typeof transcriptHash !== 'string' || transcriptHash.length > 256) {
      throw new Error('Invalid transcript hash.');
    }

    return encoder.encode(
      `${IDENTITY_SIGNATURE_PREFIX}|${role}|${transcriptHash}`
    );
  }

  async signIdentityConfirmation(privateKey, role, transcriptHash) {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      this.identityMessage(role, transcriptHash)
    );

    return this.toBase64(signature);
  }

  async verifyIdentityConfirmation(
    publicKeySpki,
    role,
    transcriptHash,
    encodedSignature
  ) {
    try {
      if (
        typeof publicKeySpki !== 'string' ||
        publicKeySpki.length > 512 ||
        typeof encodedSignature !== 'string' ||
        encodedSignature.length > 256
      ) {
        return false;
      }

      const publicKey = await crypto.subtle.importKey(
        'spki',
        this.fromBase64(publicKeySpki),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );

      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        this.fromBase64(encodedSignature),
        this.identityMessage(role, transcriptHash)
      );
    } catch {
      return false;
    }
  }

  clearIdentity() {
    this.keyPair = null;
  }

  toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';

    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(
        ...bytes.subarray(i, i + 0x8000)
      );
    }

    return btoa(binary);
  }

  fromBase64(value) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 12000
    ) {
      throw new Error('Invalid encoded data.');
    }

    let binary;

    try {
      binary = atob(value);
    } catch {
      throw new Error('Invalid Base64 data.');
    }

    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }
}
