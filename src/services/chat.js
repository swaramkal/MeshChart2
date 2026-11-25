export class ChatController {
  constructor(database) {
    this.db = database;
    this.conversations = [];
    this.activePeerId = null;
    // The UI replaces this so messages in an open, visible chat count as read.
    this.isVisible = () => true;
  }

  async load() {
    this.conversations = await this.db.getConversations();
    return this.conversations;
  }

  getConversations() {
    return [...this.conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getConversation(peerId) {
    return this.conversations.find((c) => c.peerId === peerId);
  }

  async getMessages(peerId) {
    return this.db.getMessages(peerId);
  }

  async addMessage(peerId, text, direction = 'out', status = 'queued', { messageId } = {}) {
    const conversation = this.getConversation(peerId);
    if (!conversation) throw new Error('Conversation not found.');

    const message = {
      id: messageId || crypto.randomUUID(),
      peerId,
      text,
      direction,
      createdAt: Date.now(),
      status,
    };

    if (this.db.saveMessageIfAbsent) {
      const inserted = await this.db.saveMessageIfAbsent(message);
      if (!inserted) {
        const existing = await this.db.getMessage?.(message.id);
        return existing ? { ...existing, duplicate: true } : { ...message, duplicate: true };
      }
    } else {
      await this.db.saveMessage(message);
    }

    const beingViewed = this.activePeerId === peerId && this.isVisible();
    const unread = direction === 'in' && !beingViewed
      ? (Number(conversation.unread) || 0) + 1
      : (beingViewed ? 0 : Number(conversation.unread) || 0);

    await this.db.saveConversation({
      ...conversation,
      lastMessage: text,
      lastMessageId: message.id,
      lastDirection: direction,
      lastStatus: status,
      unread,
      updatedAt: message.createdAt,
    });
    await this.load();
    return message;
  }

  async updateMessageStatus(messageId, status) {
    const store = this.db.transaction('messages', 'readwrite');
    const existing = await this.db.request(store.get(messageId));
    if (!existing) return null;
    // 'delivered' is final: a fast receipt must not be overwritten by a
    // late 'sent' or 'failed' update from the sending code path.
    if (existing.status === 'delivered') return existing;
    const updated = { ...existing, status };
    await this.db.request(store.put(updated));

    // Keep the tick shown in the chat list in step with the last message.
    const conversation = this.getConversation(existing.peerId);
    if (conversation && conversation.lastMessageId === messageId) {
      await this.db.saveConversation(
        { ...conversation, lastStatus: status },
        { touch: false }
      );
      await this.load();
    }

    return updated;
  }

  async markRead(peerId) {
    const conversation = this.getConversation(peerId);
    if (!conversation || !conversation.unread) return;

    await this.db.saveConversation(
      { ...conversation, unread: 0 },
      { touch: false }
    );
    await this.load();
  }

  async deleteConversation(peerId) {
    await this.db.deleteConversation(peerId);
    if (this.activePeerId === peerId) this.activePeerId = null;
    await this.load();
  }
}
