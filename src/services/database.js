const DB_NAME = 'meshchat-local';
const DB_VERSION = 3;

// Stores that hold user data and are included in export / clear.
const DATA_STORES = ['profile', 'conversations', 'messages', 'attachments', 'relayQueue', 'relaySeen'];
// The identity store holds the device's non-extractable signing key.
const ALL_STORES = [...DATA_STORES, 'identity'];

export class MeshDatabase {
  constructor() {
    this.db = null;
  }

  async open() {
    if (!('indexedDB' in globalThis)) {
      throw new Error('This browser does not support local IndexedDB storage.');
    }

    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains('profile')) {
          db.createObjectStore('profile', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'peerId' });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('peerId', 'peerId', { unique: false });
        }
        if (!db.objectStoreNames.contains('attachments')) {
          db.createObjectStore('attachments', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('relayQueue')) {
          db.createObjectStore('relayQueue', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('relaySeen')) {
          db.createObjectStore('relaySeen', { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error('Unable to open local database.'));
      request.onblocked = () =>
        reject(new Error('Database upgrade is blocked by another open MeshChat tab.'));
    });

    return this;
  }

  transaction(store, mode = 'readonly') {
    if (!this.db) throw new Error('Database has not been opened.');
    return this.db.transaction(store, mode).objectStore(store);
  }

  request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getProfile() {
    return (
      (await this.request(this.transaction('profile').get('self'))) ||
      { id: 'self', name: '' }
    );
  }

  async saveProfile(profile) {
    const current = await this.getProfile();
    return this.request(
      this.transaction('profile', 'readwrite').put({ ...current, ...profile, id: 'self' })
    );
  }

  async getIdentity() {
    return (await this.request(this.transaction('identity').get('signing'))) || null;
  }

  async saveIdentity({ privateKey, publicKey, publicKeySpki }) {
    return this.request(
      this.transaction('identity', 'readwrite').put({
        id: 'signing',
        privateKey,
        publicKey,
        publicKeySpki
      })
    );
  }

  async getConversations() {
    return this.request(this.transaction('conversations').getAll());
  }

  // touch: false keeps the existing sort time, for changes that are not new
  // activity (unread count, delivery tick on the last message).
  async saveConversation(conversation, { touch = true } = {}) {
    if (!conversation?.peerId || !conversation?.peerName) {
      throw new Error('A peer ID and display name are required.');
    }

    const previous = await this.request(
      this.transaction('conversations').get(conversation.peerId)
    );

    const merged = { ...previous, ...conversation };

    return this.request(
      this.transaction('conversations', 'readwrite').put({
        ...merged,
        updatedAt: touch
          ? Date.now()
          : (conversation.updatedAt ?? previous?.updatedAt ?? Date.now())
      })
    );
  }

  async deleteConversation(peerId) {
    if (!peerId) return;

    const messages = await this.getMessages(peerId);

    if (messages.length) {
      const store = this.transaction('messages', 'readwrite');
      await Promise.all(
        messages.map((message) => this.request(store.delete(message.id)))
      );
    }

    await this.request(
      this.transaction('conversations', 'readwrite').delete(peerId)
    );
  }

  // Moves a conversation and its messages to a new peer ID. Used when a
  // pinned contact reconnects from a different Bluetooth address.
  async mergeConversation(fromPeerId, toPeerId) {
    if (!fromPeerId || !toPeerId || fromPeerId === toPeerId) return;

    const from = await this.request(
      this.transaction('conversations').get(fromPeerId)
    );
    if (!from) return;

    const to = await this.request(
      this.transaction('conversations').get(toPeerId)
    );

    const messages = await this.getMessages(fromPeerId);

    for (const message of messages) {
      await this.saveMessage({ ...message, peerId: toPeerId });
    }

    const newer = (to?.updatedAt || 0) > (from.updatedAt || 0) ? to : from;

    await this.request(
      this.transaction('conversations', 'readwrite').put({
        ...from,
        ...to,
        peerId: toPeerId,
        lastMessage: newer?.lastMessage,
        updatedAt: Math.max(from.updatedAt || 0, to?.updatedAt || 0)
      })
    );

    await this.request(
      this.transaction('conversations', 'readwrite').delete(fromPeerId)
    );
  }

  async getMessages(peerId) {
    const store = this.transaction('messages');
    const messages = store.indexNames.contains('peerId')
      ? await this.request(store.index('peerId').getAll(peerId))
      : (await this.request(store.getAll())).filter(m => m.peerId === peerId);

    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }

  async saveMessage(message) {
    if (!message?.id || !message?.peerId || typeof message.text !== 'string') {
      throw new Error('Invalid message record.');
    }

    return this.request(this.transaction('messages', 'readwrite').put(message));
  }

  async saveMessageIfAbsent(message) {
    if (!message?.id || !message?.peerId || typeof message.text !== 'string') {
      throw new Error('Invalid message record.');
    }

    try {
      await this.request(this.transaction('messages', 'readwrite').add(message));
      return true;
    } catch (error) {
      if (error?.name === 'ConstraintError') return false;
      throw error;
    }
  }

  async getMessage(id) {
    if (!id) return null;
    return (await this.request(this.transaction('messages').get(id))) || null;
  }

  async saveAttachment(file) {
    return this.request(
      this.transaction('attachments', 'readwrite').put({
        id: crypto.randomUUID(),
        ...file
      })
    );
  }

  async getRelayPackets() {
    return this.request(this.transaction('relayQueue').getAll());
  }

  async getRelayPacket(id) {
    return (await this.request(this.transaction('relayQueue').get(id))) || null;
  }

  async saveRelayPacket(packet) {
    if (!packet?.id) throw new Error('A relay packet ID is required.');
    return this.request(this.transaction('relayQueue', 'readwrite').put(packet));
  }

  // Atomically reserve a relay packet and its deduplication ID. This prevents
  // simultaneous BLE/Wi-Fi receive callbacks from queueing the same packet
  // twice or exceeding the queue quota between separate read/write calls.
  async reserveRelayPacket(packet, { maxQueueItems, maxQueueBytes, now = Date.now() } = {}) {
    if (!packet?.id) throw new Error('A relay packet ID is required.');
    const tx = this.db.transaction(['relayQueue', 'relaySeen'], 'readwrite');
    const queue = tx.objectStore('relayQueue');
    const seenStore = tx.objectStore('relaySeen');
    const queueRequest = queue.getAll();
    const seenRequest = seenStore.get(packet.id);

    return new Promise((resolve, reject) => {
      let queueRecords;
      let seenRecord;
      let ready = 0;
      let outcome = { accepted: false, reason: 'storage-error' };
      const fail = () => reject(tx.error || new Error('Unable to reserve relay packet.'));
      tx.onerror = fail;
      tx.onabort = fail;
      tx.oncomplete = () => resolve(outcome);

      const reserve = () => {
        if (++ready !== 2) return;
        if (seenRecord && seenRecord.expiresAt > now) {
          outcome = { accepted: false, reason: 'duplicate' };
          return;
        }
        const active = queueRecords.filter(item => item.expiresAt > now);
        const bytes = active.reduce((sum, item) => sum + Math.floor((item.ciphertext?.length || 0) * 3 / 4) - (item.ciphertext?.endsWith('==') ? 2 : item.ciphertext?.endsWith('=') ? 1 : 0), 0);
        const incoming = Math.floor(packet.ciphertext.length * 3 / 4) - (packet.ciphertext.endsWith('==') ? 2 : packet.ciphertext.endsWith('=') ? 1 : 0);
        if (active.length >= maxQueueItems || bytes + incoming > maxQueueBytes) {
          outcome = { accepted: false, reason: 'queue-full' };
          return;
        }
        queue.put(packet);
        seenStore.put({ id: packet.id, expiresAt: packet.expiresAt });
        outcome = { accepted: true, reason: 'queued' };
      };
      queueRequest.onsuccess = () => { queueRecords = queueRequest.result; reserve(); };
      seenRequest.onsuccess = () => { seenRecord = seenRequest.result; reserve(); };
      queueRequest.onerror = fail;
      seenRequest.onerror = fail;
    });
  }

  async deleteRelayPacket(id) {
    return this.request(this.transaction('relayQueue', 'readwrite').delete(id));
  }

  async getRelaySeen(id) {
    return (await this.request(this.transaction('relaySeen').get(id))) || null;
  }

  async saveRelaySeen(record) {
    if (!record?.id || !Number.isSafeInteger(record.expiresAt)) {
      throw new Error('Invalid relay deduplication record.');
    }
    return this.request(this.transaction('relaySeen', 'readwrite').put(record));
  }

  async clearRelayPackets() {
    return this.request(this.transaction('relayQueue', 'readwrite').clear());
  }

  async cleanupRelayData(now = Date.now()) {
    for (const storeName of ['relayQueue', 'relaySeen']) {
      const store = this.transaction(storeName, 'readwrite');
      const records = await this.request(store.getAll());
      await Promise.all(records.filter(item => item.expiresAt <= now)
        .map(item => this.request(store.delete(item.id))));
    }
  }

  async exportAll() {
    const [profile, conversations, messages, attachments, relayQueue, relaySeen] = await Promise.all(
      DATA_STORES.map(store => this.request(this.transaction(store).getAll()))
    );

    return {
      schemaVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      profile,
      conversations,
      messages,
      attachments,
      relayQueue,
      relaySeen
    };
  }

  async clear() {
    await Promise.all(
      ALL_STORES.map(store =>
        this.request(this.transaction(store, 'readwrite').clear())
      )
    );

    await this.saveProfile({ name: '' });
  }
}
