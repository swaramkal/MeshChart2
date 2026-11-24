// Pure helpers for the WhatsApp-style chat list and message history.
// Kept free of DOM access so they can be unit tested.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

const pad = (value) => String(value).padStart(2, '0');

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function daysBetween(timestamp, now) {
  return Math.round((startOfDay(now) - startOfDay(timestamp)) / 86400000);
}

export function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatClock(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Time shown on the right of a chat list row.
export function formatListTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';

  const days = daysBetween(timestamp, now);

  if (days <= 0) return formatClock(timestamp);
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[new Date(timestamp).getDay()];

  const date = new Date(timestamp);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// Heading above each day's messages.
export function formatDayLabel(timestamp, now = Date.now()) {
  const days = daysBetween(timestamp, now);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';

  const date = new Date(timestamp);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function groupMessagesByDay(messages, now = Date.now()) {
  const groups = [];

  for (const message of messages) {
    const key = dayKey(message.createdAt);
    const last = groups[groups.length - 1];

    if (last && last.key === key) {
      last.messages.push(message);
    } else {
      groups.push({
        key,
        label: formatDayLabel(message.createdAt, now),
        messages: [message]
      });
    }
  }

  return groups;
}

export function tickFor(status) {
  switch (status) {
    case 'delivered':
      return { symbol: '✓✓', className: 'delivered', label: 'Delivered' };
    case 'sent':
      return { symbol: '✓', className: 'sent', label: 'Sent' };
    case 'failed':
      return { symbol: '!', className: 'failed', label: 'Not sent' };
    default:
      return { symbol: '◷', className: 'queued', label: 'Sending' };
  }
}

export function previewText(conversation) {
  const text = String(conversation?.lastMessage || '').replace(/\s+/g, ' ').trim();
  return text || 'Start a conversation';
}

// Stable colour for a contact's avatar, derived from the name.
export function avatarHue(name = '') {
  let hash = 0;

  for (const char of String(name)) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }

  return hash;
}

export function filterConversations(conversations, query = '') {
  const needle = query.trim().toLowerCase();
  if (!needle) return conversations;

  return conversations.filter((conversation) =>
    String(conversation.peerName || '').toLowerCase().includes(needle) ||
    String(conversation.lastMessage || '').toLowerCase().includes(needle)
  );
}

export function totalUnread(conversations) {
  return conversations.reduce(
    (sum, conversation) => sum + (Number(conversation.unread) || 0),
    0
  );
}

export function unreadLabel(count) {
  return count > 99 ? '99+' : String(count);
}
