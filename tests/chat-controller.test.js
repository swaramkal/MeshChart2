import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatController } from '../src/services/chat.js';

// Minimal in-memory stand-in for MeshDatabase.
class FakeDb {
  constructor() {
    this.conversations = new Map();
    this.messages = new Map();
  }

  async getConversations() {
    return [...this.conversations.values()].map(c => ({ ...c }));
  }

  async saveConversation(conversation, { touch = true } = {}) {
    const previous = this.conversations.get(conversation.peerId);
    this.conversations.set(conversation.peerId, {
      ...previous,
      ...conversation,
      updatedAt: touch
        ? Date.now()
        : (conversation.updatedAt ?? previous?.updatedAt ?? Date.now())
    });
  }

  async saveMessage(message) {
    this.messages.set(message.id, { ...message });
  }

  async getMessages(peerId) {
    return [...this.messages.values()]
      .filter(m => m.peerId === peerId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async deleteConversation(peerId) {
    for (const [id, m] of this.messages) {
      if (m.peerId === peerId) this.messages.delete(id);
    }
    this.conversations.delete(peerId);
  }

  transaction() {
    return {
      get: id => ({ value: this.messages.get(id) }),
      put: message => {
        this.messages.set(message.id, message);
        return { value: message };
      }
    };
  }

  request(req) {
    return Promise.resolve(req.value);
  }
}

async function setup() {
  const db = new FakeDb();
  await db.saveConversation({ peerId: 'p1', peerName: 'Ravi' });
  const chat = new ChatController(db);
  await chat.load();
  return { db, chat };
}

test('incoming messages in a chat that is not open count as unread', async () => {
  const { chat } = await setup();

  await chat.addMessage('p1', 'hi', 'in', 'delivered');
  await chat.addMessage('p1', 'there', 'in', 'delivered');

  assert.equal(chat.getConversation('p1').unread, 2);
  assert.equal(chat.getConversation('p1').lastMessage, 'there');
  assert.equal(chat.getConversation('p1').lastDirection, 'in');
});

test('incoming messages in the open, visible chat are not unread', async () => {
  const { chat } = await setup();
  chat.activePeerId = 'p1';

  await chat.addMessage('p1', 'hi', 'in', 'delivered');

  assert.equal(chat.getConversation('p1').unread, 0);
});

test('a hidden app still counts messages as unread', async () => {
  const { chat } = await setup();
  chat.activePeerId = 'p1';
  chat.isVisible = () => false;

  await chat.addMessage('p1', 'hi', 'in', 'delivered');

  assert.equal(chat.getConversation('p1').unread, 1);
});

test('markRead clears unread without changing the sort time', async () => {
  const { chat } = await setup();
  await chat.addMessage('p1', 'hi', 'in', 'delivered');
  const before = chat.getConversation('p1').updatedAt;

  await new Promise(resolve => setTimeout(resolve, 5));
  await chat.markRead('p1');

  assert.equal(chat.getConversation('p1').unread, 0);
  assert.equal(chat.getConversation('p1').updatedAt, before);
});

test('a delivery receipt updates the tick on the last message only', async () => {
  const { chat } = await setup();
  const first = await chat.addMessage('p1', 'one', 'out', 'sent');
  const second = await chat.addMessage('p1', 'two', 'out', 'sent');

  await chat.updateMessageStatus(first.id, 'delivered');
  assert.equal(chat.getConversation('p1').lastStatus, 'sent');

  await chat.updateMessageStatus(second.id, 'delivered');
  assert.equal(chat.getConversation('p1').lastStatus, 'delivered');
});

test('delivered is final and is not overwritten by a late sent', async () => {
  const { chat } = await setup();
  const message = await chat.addMessage('p1', 'one', 'out', 'queued');

  await chat.updateMessageStatus(message.id, 'delivered');
  await chat.updateMessageStatus(message.id, 'sent');

  const [stored] = await chat.getMessages('p1');
  assert.equal(stored.status, 'delivered');
  assert.equal(chat.getConversation('p1').lastStatus, 'delivered');
});

test('deleting a conversation removes its messages and closes it', async () => {
  const { db, chat } = await setup();
  await chat.addMessage('p1', 'hello', 'out', 'sent');
  chat.activePeerId = 'p1';

  await chat.deleteConversation('p1');

  assert.equal(chat.getConversation('p1'), undefined);
  assert.equal(chat.activePeerId, null);
  assert.equal((await db.getMessages('p1')).length, 0);
});
