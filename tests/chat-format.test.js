import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatListTime,
  formatDayLabel,
  formatClock,
  groupMessagesByDay,
  tickFor,
  previewText,
  avatarHue,
  filterConversations,
  totalUnread,
  unreadLabel
} from '../src/ui/chat-format.js';

const now = new Date(2026, 10, 23, 15, 30).getTime(); // 23 Nov 2026, 15:30

test('list time shows the clock for today, then Yesterday, weekday and date', () => {
  assert.equal(formatListTime(new Date(2026, 10, 23, 9, 5).getTime(), now), '09:05');
  assert.equal(formatListTime(new Date(2026, 10, 22, 23, 59).getTime(), now), 'Yesterday');
  assert.equal(formatListTime(new Date(2026, 10, 19, 12, 0).getTime(), now), 'Thursday');
  assert.equal(formatListTime(new Date(2026, 9, 1, 12, 0).getTime(), now), '01/10/2026');
  assert.equal(formatListTime(0, now), '');
});

test('day labels use Today, Yesterday, then a full date', () => {
  assert.equal(formatDayLabel(now, now), 'Today');
  assert.equal(formatDayLabel(new Date(2026, 10, 22, 1, 0).getTime(), now), 'Yesterday');
  assert.equal(formatDayLabel(new Date(2026, 8, 5, 1, 0).getTime(), now), '5 September 2026');
});

test('clock formatting is zero padded', () => {
  assert.equal(formatClock(new Date(2026, 0, 1, 7, 3).getTime()), '07:03');
});

test('messages are grouped under one heading per day, in order', () => {
  const messages = [
    { id: 'a', createdAt: new Date(2026, 10, 22, 10, 0).getTime() },
    { id: 'b', createdAt: new Date(2026, 10, 22, 11, 0).getTime() },
    { id: 'c', createdAt: new Date(2026, 10, 23, 8, 0).getTime() }
  ];

  const groups = groupMessagesByDay(messages, now);

  assert.deepEqual(groups.map(g => g.label), ['Yesterday', 'Today']);
  assert.deepEqual(groups[0].messages.map(m => m.id), ['a', 'b']);
  assert.deepEqual(groups[1].messages.map(m => m.id), ['c']);
  assert.deepEqual(groupMessagesByDay([], now), []);
});

test('ticks map each delivery status', () => {
  assert.equal(tickFor('delivered').symbol, '✓✓');
  assert.equal(tickFor('sent').symbol, '✓');
  assert.equal(tickFor('failed').className, 'failed');
  assert.equal(tickFor('queued').className, 'queued');
  assert.equal(tickFor(undefined).className, 'queued');
});

test('preview collapses whitespace and has an empty-state text', () => {
  assert.equal(previewText({ lastMessage: '  hello\n\n  world ' }), 'hello world');
  assert.equal(previewText({}), 'Start a conversation');
});

test('avatar hue is stable and within 0-359', () => {
  assert.equal(avatarHue('Ravi'), avatarHue('Ravi'));
  assert.ok(avatarHue('Ravi') >= 0 && avatarHue('Ravi') < 360);
  assert.notEqual(avatarHue('Ravi'), avatarHue('Sita'));
});

test('search matches names and last message text', () => {
  const chats = [
    { peerId: '1', peerName: 'Ravi', lastMessage: 'exam tomorrow' },
    { peerId: '2', peerName: 'Sita', lastMessage: 'see you' }
  ];

  assert.deepEqual(filterConversations(chats, 'rav').map(c => c.peerId), ['1']);
  assert.deepEqual(filterConversations(chats, 'EXAM').map(c => c.peerId), ['1']);
  assert.equal(filterConversations(chats, '').length, 2);
  assert.equal(filterConversations(chats, 'zzz').length, 0);
});

test('unread totals and labels', () => {
  assert.equal(totalUnread([{ unread: 2 }, { unread: 3 }, {}]), 5);
  assert.equal(unreadLabel(7), '7');
  assert.equal(unreadLabel(150), '99+');
});
