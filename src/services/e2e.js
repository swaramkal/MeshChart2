// End-to-end sealed messages for multi-hop delivery.
//
// A relay phone only ever sees an opaque blob. The sender encrypts to the
// recipient's static ECDH box key (ECIES: ephemeral ECDH P-256 -> HKDF-SHA256 ->
// AES-256-GCM) and signs the plaintext with its pinned ECDSA identity key, so
// the recipient can prove who sent it. Box keys are exchanged over the already
// authenticated pairing channel; no new trust path is introduced.

const VERSION = 1;
const PREFIX = 'meshchat-e2e-v1';
const MAX_BLOB_CHARS = 8000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 5 * 60 * 1000;
export const MAX_MESH_TEXT_BYTES = 400;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tagOf(fingerprint) {
  return String(fingerprint).toLowerCase().slice(0, 16);
}

export class E2EService {
  constructor(cryptoService) {
    this.crypto = cryptoService;
  }

  async createBoxIdentity() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeySpki: this.crypto.toBase64(spki) };
  }

  async importBoxPublicKey(spki) {
    if (typeof spki !== 'string' || spki.length < 80 || spki.length > 200) throw new Error('Invalid box key.');
    return crypto.subtle.importKey('spki', this.crypto.fromBase64(spki), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }

  async isValidBoxKey(spki) {
    try { await this.importBoxPublicKey(spki); return true; } catch { return false; }
  }

  async deriveKey(privateKey, publicKey, to, usage) {
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(`${PREFIX}|${to}`) },
      material, { name: 'AES-GCM', length: 256 }, false, [usage]
    );
  }

  signedText(p) {
    return encoder.encode(`${PREFIX}|${p.k}|${p.id}|${p.from}|${p.to}|${p.ts}|${p.text ?? ''}`);
  }

  // Returns a base64 string that is safe for a relay to carry.
  async seal({ identityPrivateKey, fromFingerprint, toFingerprint, recipientBoxKey, kind, id, text, now = Date.now() }) {
    const recipientPublic = await this.importBoxPublicKey(recipientBoxKey);
    const body = { k: kind, id, from: String(fromFingerprint).toLowerCase(), to: String(toFingerprint).toLowerCase(), ts: now };
    if (text !== undefined) body.text = text;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identityPrivateKey, this.signedText(body));
    body.sig = this.crypto.toBase64(signature);

    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const key = await this.deriveKey(eph.privateKey, recipientPublic, body.to, 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`${PREFIX}|${tagOf(body.to)}`) },
      key, encoder.encode(JSON.stringify(body))
    );
    const blob = {
      v: VERSION,
      t: tagOf(body.to),
      e: this.crypto.toBase64(await crypto.subtle.exportKey('spki', eph.publicKey)),
      iv: this.crypto.toBase64(iv),
      c: this.crypto.toBase64(ct)
    };
    return btoa(JSON.stringify(blob));
  }

  parseBlob(ciphertext) {
    try {
      if (typeof ciphertext !== 'string' || ciphertext.length > MAX_BLOB_CHARS) return null;
      const blob = JSON.parse(atob(ciphertext));
      if (blob?.v !== VERSION || typeof blob.t !== 'string' || typeof blob.e !== 'string' ||
          typeof blob.iv !== 'string' || typeof blob.c !== 'string') return null;
      return blob;
    } catch { return null; }
  }

  // True when the blob's routing tag names this device. Reveals nothing else.
  isForMe(ciphertext, myFingerprint) {
    const blob = this.parseBlob(ciphertext);
    return Boolean(blob) && blob.t === tagOf(myFingerprint);
  }

  // Resolves to the verified payload, or throws. lookupIdentityKey(fp) returns
  // the pinned ECDSA SPKI of a paired contact, or null.
  async open({ ciphertext, boxPrivateKey, myFingerprint, lookupIdentityKey, now = Date.now() }) {
    const blob = this.parseBlob(ciphertext);
    if (!blob || blob.t !== tagOf(myFingerprint)) throw new Error('Not addressed to this device.');

    const eph = await this.importBoxPublicKey(blob.e);
    const me = String(myFingerprint).toLowerCase();
    const key = await this.deriveKey(boxPrivateKey, eph, me, 'decrypt');
    let body;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.crypto.fromBase64(blob.iv), additionalData: encoder.encode(`${PREFIX}|${blob.t}`) },
        key, this.crypto.fromBase64(blob.c)
      );
      body = JSON.parse(decoder.decode(plain));
    } catch { throw new Error('Sealed message could not be decrypted.'); }

    if (!body || !['text', 'ack'].includes(body.k) || typeof body.id !== 'string' ||
        !/^[A-Za-z0-9_-]{8,80}$/.test(body.id) || body.to !== me ||
        typeof body.from !== 'string' || !/^[a-f0-9]{64}$/.test(body.from) ||
        !Number.isSafeInteger(body.ts) || typeof body.sig !== 'string' ||
        (body.k === 'text' && (typeof body.text !== 'string' || !body.text.trim() ||
          encoder.encode(body.text).length > MAX_MESH_TEXT_BYTES))) {
      throw new Error('Invalid sealed message.');
    }
    if (body.ts > now + MAX_SKEW_MS || now - body.ts > MAX_AGE_MS) throw new Error('Sealed message is too old.');

    const senderKey = await lookupIdentityKey(body.from);
    if (!senderKey) throw new Error('Sender is not a verified contact.');
    if (await this.crypto.fingerprintOf(senderKey) !== body.from) throw new Error('Sender key mismatch.');
    const publicKey = await crypto.subtle.importKey('spki', this.crypto.fromBase64(senderKey),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
      this.crypto.fromBase64(body.sig), this.signedText(body));
    if (!valid) throw new Error('Sender signature is invalid.');
    return body;
  }
}
