import './styles.css';
import { MeshDatabase } from './services/database.js';
import { CryptoService } from './services/crypto.js';
import { BluetoothAdapter } from './services/bluetooth.js';
import { ChatController } from './services/chat.js';
import { PairingController } from './services/pairing.js';
import { sealPayload, openPacket } from './services/secure-channel.js';
import {
  formatListTime,
  formatClock,
  groupMessagesByDay,
  tickFor,
  previewText,
  avatarHue,
  filterConversations,
  totalUnread,
  unreadLabel
} from './ui/chat-format.js';

const $ = (selector) => document.querySelector(selector);
const db = new MeshDatabase();
const bluetooth = new BluetoothAdapter();
const cryptoService = new CryptoService();
const chat = new ChatController(db);
let activeView = 'chats';
let scanning = false;
let onboardingRequired = false;
let toastTimer;
let activePairingPeerId = null;
const pairingStates = new Map();
let identityPromise = null;
let lastPeerSignature = null;
let peerRenderTimer = null;
let peerListPressed = false;
let chatQuery = '';

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}


function pairingStatusText(status, trusted = false) {
  if (trusted && status === 'awaiting-confirmation') {
    return 'Known contact recognised. Confirming automatically…';
  }

  const messages = {
    negotiating: 'Establishing a secure connection…',
    'awaiting-confirmation': 'Compare the six-digit code on both phones. Confirm only if they match.',
    'awaiting-peer-confirmation': 'Waiting for the other person to confirm the matching code…',
    secure: 'Secure pairing confirmed. Encrypted one-to-one messaging is ready.',
    timeout: 'Pairing timed out. Reconnect and try again.',
    failed: 'Pairing failed. Please reconnect and try again.',
    disconnected: 'Bluetooth disconnected. Pairing was cancelled.',
    'peer-cancelled': 'The other device cancelled pairing.',
    'verification-failed': 'Verification failed. Pair again.',
    cancelled: 'Pairing cancelled.',
    restarted: 'Pairing restarted.',
    destroyed: 'Pairing session ended.'
  };
  return messages[status] || `Pairing status: ${String(status || 'unknown')}`;
}

function renderPairingState(state) {
  pairingStates.set(state.peerId, state);

  if (!activePairingPeerId || activePairingPeerId === state.peerId) {
    activePairingPeerId = state.peerId;
  } else {
    return;
  }

  const dialog = $('#pairing-dialog');
  if (!dialog) return;

  $('#pairing-peer-name').textContent = state.peerName || 'Nearby device';
  $('#pairing-status').textContent = pairingStatusText(state.status, state.trusted);
  $('#pairing-code').textContent = state.verificationCode || '------';
  $('#pairing-code-wrap').classList.toggle('hidden', !state.verificationCode);

  const terminal = [
    'secure', 'timeout', 'failed', 'disconnected',
    'peer-cancelled', 'verification-failed', 'cancelled',
    'restarted', 'destroyed'
  ].includes(state.status);

  $('#pairing-confirm').classList.toggle(
    'hidden', state.status !== 'awaiting-confirmation' || Boolean(state.trusted)
  );
  $('#pairing-cancel').textContent = terminal ? 'Close' : 'Cancel pairing';

  if (!dialog.open) dialog.showModal();
}

// The device identity is created once and kept across restarts. Its private
// key is non-extractable, so it cannot be exported from the app.
function getLocalIdentity() {
  identityPromise ||= (async () => {
    let record = await db.getIdentity();

    if (!record) {
      record = await cryptoService.createSigningIdentity();
      await db.saveIdentity(record);
    }

    return {
      privateKey: record.privateKey,
      publicKeySpki: record.publicKeySpki
    };
  })().catch((error) => {
    identityPromise = null;
    throw error;
  });

  return identityPromise;
}

// A contact is trusted once a pairing with its identity was confirmed.
async function findTrustedContact(fingerprint) {
  return chat.conversations.find((c) => c.fingerprint === fingerprint) || null;
}

async function handleSecured(peerId, session) {
  try {
    const previous = chat.conversations.find(
      (c) => c.fingerprint === session.remoteFingerprint && c.peerId !== peerId
    );

    await db.saveConversation({
      peerId,
      peerName: session.peerName || 'Nearby MeshChat device',
      fingerprint: session.remoteFingerprint,
      connected: true
    });

    if (previous) {
      // The contact came back from a new Bluetooth address: keep one thread.
      await db.mergeConversation(previous.peerId, peerId);
      if (chat.activePeerId === previous.peerId) chat.activePeerId = peerId;
    }

    await chat.load();
    renderChatList();

    if (chat.activePeerId === peerId) {
      $('#conversation-status').textContent = 'Secure paired · encrypted chat';
      await renderMessages();
    }
  } catch (error) {
    console.error('Unable to record the paired contact:', error);
  }

  toast(
    session.wasTrusted
      ? 'Known contact reconnected securely.'
      : 'Secure pairing confirmed. Encrypted chat is ready.'
  );
}

const pairing = new PairingController(bluetooth, {
  onState: renderPairingState,
  onSecure: handleSecured,
  getIdentity: getLocalIdentity,
  findTrusted: findTrustedContact
});

// Encrypt every chat payload using the key established by verified pairing.
// sealPayload adds a replay counter and binds the sender's role.
async function sendSecurePayload(peerId, payload) {
  const session = pairing.getSecureSession(peerId);
  const packet = await sealPayload(cryptoService, session, payload);
  return bluetooth.send(packet, peerId);
}


function initials(name = '?') {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function setView(view) {
  activeView = view;
  document.querySelectorAll('.view').forEach((el) =>
    el.classList.toggle('active', el.id === `view-${view}`)
  );
  document.querySelectorAll('.nav-link').forEach((el) =>
    el.classList.toggle('active', el.dataset.view === view)
  );
  document.querySelector('.sidebar')?.classList.remove('mobile-open');
  syncChatMode();
}

// On phones an open conversation fills the screen, like WhatsApp.
function syncChatMode() {
  document.body.classList.toggle(
    'in-chat',
    activeView === 'chats' && Boolean(chat.activePeerId)
  );
}

function avatarHTML(name, extraClass = '') {
  return `<span class="avatar ${extraClass}" style="background:hsl(${avatarHue(name)} 42% 38%)">${escapeHTML(initials(name))}</span>`;
}


function chatRowHTML(c) {
  const unread = Number(c.unread) || 0;
  const tick = c.lastDirection === 'out' && c.lastMessage
    ? `<span class="tick ${tickFor(c.lastStatus).className}">${tickFor(c.lastStatus).symbol}</span>`
    : '';

  return `
    <button class="chat-item ${chat.activePeerId === c.peerId ? 'selected' : ''} ${unread ? 'has-unread' : ''}"
      data-peer="${escapeHTML(c.peerId)}">
      ${avatarHTML(c.peerName)}
      ${c.connected ? '<span class="online-dot" title="Connected"></span>' : ''}
      <span class="chat-item-main">
        <span class="chat-item-top">
          <strong>${escapeHTML(c.peerName)}</strong>
          <small class="chat-time">${escapeHTML(formatListTime(c.updatedAt))}</small>
        </span>
        <span class="chat-item-bottom">
          <small class="chat-preview">${tick}${escapeHTML(previewText(c))}</small>
          ${unread ? `<span class="unread-badge">${unreadLabel(unread)}</span>` : ''}
        </span>
      </span>
    </button>
  `;
}

function renderChatList() {
  const chats = chat.getConversations();
  const filtered = filterConversations(chats, chatQuery);
  const unread = totalUnread(chats);

  $('#chat-count').textContent = String(chats.length);
  $('#home-chat-count').textContent = unread
    ? `${unread} unread`
    : `${chats.length} chat${chats.length === 1 ? '' : 's'}`;

  const html = filtered.length
    ? filtered.map(chatRowHTML).join('')
    : `<div class="empty-small">${
        chats.length ? 'No chats match your search.' : 'No conversations yet.'
      }</div>`;

  $('#chat-list').innerHTML = html;
  $('#home-chat-list').innerHTML = html;

  // Total unread on the Chats tab.
  document.querySelectorAll('.nav-link[data-view="chats"]').forEach((el) => {
    let badge = el.querySelector('.nav-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      el.appendChild(badge);
    }
    badge.textContent = unreadLabel(unread);
    badge.hidden = unread === 0;
  });

  // Phones show the chat list as the home screen until a chat is opened.
  $('#chat-home').classList.toggle(
    'hidden',
    chats.length === 0 || Boolean(chat.activePeerId)
  );

  syncChatMode();
}


function messageHTML(m) {
  const outgoing = m.direction === 'out';
  const tick = tickFor(m.status);

  return `
    <div class="message-row ${outgoing ? 'outgoing' : 'incoming'}">
      <div class="message-bubble">
        <span class="message-text">${escapeHTML(m.text)}</span>
        <small class="message-meta">${formatClock(m.createdAt)}${
          outgoing
            ? ` <span class="tick ${tick.className}" aria-label="${tick.label}">${tick.symbol}</span>`
            : ''
        }</small>
      </div>
    </div>
  `;
}

async function renderMessages() {
  const peerId = chat.activePeerId;
  if (!peerId) return;

  const messages = await chat.getMessages(peerId);

  $('#message-list').innerHTML = messages.length
    ? groupMessagesByDay(messages).map((group) => `
        <div class="day-separator"><span>${escapeHTML(group.label)}</span></div>
        ${group.messages.map(messageHTML).join('')}
      `).join('')
    : '<div class="conversation-empty">This is the beginning of your conversation.</div>';

  $('#message-list').scrollTop = $('#message-list').scrollHeight;
}


async function openConversation(peerId) {
  const conversation = chat.getConversation(peerId);
  if (!conversation) return;

  chat.activePeerId = peerId;
  $('#welcome-panel').classList.add('hidden');
  $('#conversation-panel').classList.remove('hidden');
  $('#conversation-name').textContent = conversation.peerName;
  $('#conversation-avatar').textContent = initials(conversation.peerName);
  $('#conversation-avatar').style.background =
    `hsl(${avatarHue(conversation.peerName)} 42% 38%)`;

  $('#conversation-status').textContent = pairing.isSecure(peerId)
    ? 'Secure paired · encrypted chat'
    : conversation.connected
      ? 'Connected nearby · pairing required'
      : 'Saved conversation · not connected';

  await chat.markRead(peerId);
  await renderMessages();
  renderChatList();
  setView('chats');
}

function closeConversation() {
  chat.activePeerId = null;
  $('#conversation-panel').classList.add('hidden');
  $('#welcome-panel').classList.remove('hidden');
  renderChatList();
}

async function deleteActiveChat() {
  const peerId = chat.activePeerId;
  const conversation = chat.getConversation(peerId);
  if (!conversation) return;

  const ok = window.confirm(
    `Delete the chat with ${conversation.peerName}? All its messages on this phone will be removed.`
  );
  if (!ok) return;

  await chat.deleteConversation(peerId);
  closeConversation();
  toast('Chat deleted.');
}


function renderPeers(peers) {
  // Skip the DOM rebuild when nothing visible changed (scan results arrive
  // many times per second) so a tap on "Connect" is never lost to a re-render.
  const signature = peers
    .map((p) => `${p.id}|${p.name}|${p.connected ? 1 : 0}`)
    .sort()
    .join(';');

  if (signature === lastPeerSignature) return;
  lastPeerSignature = signature;

  $('#peer-count').textContent =
    `${peers.length} device${peers.length === 1 ? '' : 's'}`;

  $('#peer-list').innerHTML = peers.length
    ? peers.map((p) => `
      <div class="peer-item">
        <span class="avatar">${escapeHTML(initials(p.name))}</span>
        <div class="peer-copy">
          <strong>${escapeHTML(p.name)}</strong>
          <small>${escapeHTML(p.id)}</small>
        </div>
        <span class="peer-signal">${p.connected ? 'Connected' : 'Nearby'}</span>
        <button class="secondary-button connect-peer"
          data-peer="${escapeHTML(p.id)}"
          data-name="${escapeHTML(p.name)}">Connect</button>
      </div>
    `).join('')
    : '<div class="empty-state">No devices discovered yet.</div>';
}

function schedulePeerRender() {
  clearTimeout(peerRenderTimer);
  peerRenderTimer = setTimeout(() => {
    // Hold the update while a finger is on the list.
    if (peerListPressed) {
      schedulePeerRender();
      return;
    }
    renderPeers(bluetooth.getPeers());
  }, 250);
}

async function connectToPeer(button) {
  const peer = {
    id: button.dataset.peer,
    name: button.dataset.name
  };

  button.disabled = true;

  try {
    await bluetooth.connect(peer.id);
    await db.saveConversation({
      peerId: peer.id,
      peerName: peer.name,
      connected: true
    });
    await chat.load();

    activePairingPeerId = peer.id;
    await pairing.start(peer.id, peer.name);

    renderChatList();
    await openConversation(peer.id);
    toast('Connected. Securing the connection…');
  } catch (error) {
    toast(error.message || 'Bluetooth connection failed.');
  } finally {
    button.disabled = false;
  }
}

async function refreshProfile() {
  const profile = await db.getProfile();
  const name = (profile.name || '').trim();
  $('#profile-name').textContent = name || 'Set your name';
  $('.avatar-self').textContent = initials(name || '?');
  $('#name-field').value = name;
  $('#profile-edit').title = 'Edit profile';
  return { ...profile, name };
}

function openProfileDialog(firstLaunch = false) {
  onboardingRequired = firstLaunch;
  const dialog = $('#profile-dialog');
  dialog.querySelectorAll('[value="cancel"]').forEach((button) => {
    button.style.display = firstLaunch ? 'none' : '';
  });
  dialog.querySelector('h2').textContent = firstLaunch
    ? 'Welcome to MeshChat'
    : 'Edit your profile';
  $('#name-field').required = true;
  if (!dialog.open) dialog.showModal();
  $('#name-field').focus();
}

async function saveProfile(event) {
  event.preventDefault();
  const name = $('#name-field').value.trim();
  if (!name) return;
  await db.saveProfile({ name });
  onboardingRequired = false;
  $('#profile-dialog').querySelectorAll('[value="cancel"]').forEach((button) => {
    button.style.display = '';
  });
  $('#profile-dialog').close();
  await refreshProfile();

  try {
    await bluetooth.updateDisplayName(name);
  } catch (error) {
    console.warn('Unable to refresh BLE display name:', error);
    toast('Name saved. It will be advertised on the next discovery scan.');
    return;
  }

  toast('Profile saved on this device.');
}

async function init() {
  await db.open();
  const savedProfile = await refreshProfile();
  await chat.load();
  renderChatList();
  $('#network-state').textContent = 'Ready · offline mode';
  $('#top-status').textContent = 'Offline-ready · No internet required';
  $('#profile-edit').addEventListener('click', () => openProfileDialog(false));
  $('#settings-profile').addEventListener('click', () => openProfileDialog(false));
  $('#profile-form').addEventListener('submit', saveProfile);
  $('#profile-dialog').addEventListener('cancel', (event) => {
    if (onboardingRequired) event.preventDefault();
  });
  const syncSearch = (value) => {
    chatQuery = value;
    $('#chat-search').value = value;
    $('#home-search').value = value;
    renderChatList();
  };
  $('#chat-search').addEventListener('input', (e) => syncSearch(e.target.value));
  $('#home-search').addEventListener('input', (e) => syncSearch(e.target.value));

  // One delegated handler per list, so re-rendering never loses a tap.
  for (const list of [$('#chat-list'), $('#home-chat-list')]) {
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.chat-item');
      if (row) openConversation(row.dataset.peer);
    });
  }

  $('#delete-chat').addEventListener('click', deleteActiveChat);

  // Messages that arrive while the app is in the background stay unread.
  chat.isVisible = () => !document.hidden && activeView === 'chats';
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && chat.activePeerId) {
      await chat.markRead(chat.activePeerId);
      renderChatList();
    }
  });
  $('#discover-cta').addEventListener('click', () => {
    setView('nearby');
    startScan();
  });
  $('#scan-button').addEventListener('click', startScan);
  $('#learn-more').addEventListener('click', () => $('#info-dialog').showModal());
  $('#conversation-info').addEventListener('click', () => $('#info-dialog').showModal());
  $('#back-chats').addEventListener('click', closeConversation);
  $('#message-form').addEventListener('submit', sendMessage);
  $('#attach-button').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', handleFile);
  $('#theme-toggle').addEventListener('click', () => {
    document.documentElement.classList.toggle('light');
    localStorage.setItem(
      'meshchat-theme',
      document.documentElement.classList.contains('light') ? 'light' : 'dark'
    );
  });
  if (localStorage.getItem('meshchat-theme') === 'light')
    document.documentElement.classList.add('light');
  document.querySelectorAll('.nav-link').forEach((el) =>
    el.addEventListener('click', () => setView(el.dataset.view))
  );
  $('#export-data').addEventListener('click', exportData);
  $('#clear-data').addEventListener('click', clearData);
  $('#mobile-menu')?.addEventListener('click', () =>
    document.querySelector('.sidebar')?.classList.toggle('mobile-open')
  );
  bluetooth.onPeer(() => schedulePeerRender());

  const peerList = $('#peer-list');
  peerList.addEventListener('pointerdown', () => { peerListPressed = true; });
  const releasePeerList = () => {
    setTimeout(() => { peerListPressed = false; }, 300);
  };
  peerList.addEventListener('pointerup', releasePeerList);
  peerList.addEventListener('pointercancel', releasePeerList);
  peerList.addEventListener('click', (event) => {
    const button = event.target.closest('.connect-peer');
    if (button) connectToPeer(button);
  });


  $('#pairing-confirm').addEventListener('click', async () => {
    if (!activePairingPeerId) return;

    const button = $('#pairing-confirm');
    button.disabled = true;
    try {
      await pairing.confirmLocal(activePairingPeerId);
    } catch (error) {
      toast(error.message || 'Unable to confirm pairing.');
    } finally {
      button.disabled = false;
    }
  });

  $('#pairing-cancel').addEventListener('click', () => {
    const peerId = activePairingPeerId;
    const state = peerId ? pairingStates.get(peerId) : null;
    const terminal = state && [
      'secure', 'timeout', 'failed', 'disconnected',
      'peer-cancelled', 'verification-failed', 'cancelled',
      'restarted', 'destroyed'
    ].includes(state.status);

    if (peerId && !terminal) pairing.cancel(peerId, 'cancelled', true);
    $('#pairing-dialog').close();
    activePairingPeerId = null;
  });

  $('#pairing-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    $('#pairing-cancel').click();
  });

  bluetooth.onIncomingConnection(async (peer) => {
    try {
      await db.saveConversation({
        peerId: peer.id,
        peerName: peer.name || 'Nearby MeshChat device',
        connected: true,
      });
      await chat.load();
      renderChatList();
      toast('A nearby MeshChat device connected.');
    } catch (error) {
      console.error('Unable to save incoming peer:', error);
    }
  });


  // Only accept encrypted chat packets from an established pairing session.
  bluetooth.onMessage(async ({ data, peerId }) => {
    if (!data || !peerId) return;

    try {
      const session = pairing.getSecureSession(peerId);
      if (!session) return;

      // Returns null for pairing traffic; throws on forged or replayed data.
      const payload = await openPacket(cryptoService, session, data);
      if (!payload) return;

      if (payload.kind === 'ack' && typeof payload.id === 'string') {
        await chat.updateMessageStatus(payload.id, 'delivered');
        if (chat.activePeerId === peerId) await renderMessages();
        renderChatList();
        return;
      }

      if (
        payload.kind !== 'text' ||
        typeof payload.id !== 'string' ||
        typeof payload.text !== 'string' ||
        !payload.text.trim()
      ) {
        return;
      }

      if (!chat.getConversation(peerId)) {
        const known = bluetooth.getPeers().find((p) => p.id === peerId);
        await db.saveConversation({
          peerId,
          peerName: known?.name || session.peerName || 'Nearby MeshChat device',
          connected: true
        });
        await chat.load();
      }

      await chat.addMessage(peerId, payload.text, 'in', 'delivered');

      // Send a cryptographically protected receipt to the sender.
      await sendSecurePayload(peerId, {
        kind: 'ack',
        id: payload.id
      });

      if (chat.activePeerId === peerId) await renderMessages();
      renderChatList();
    } catch (error) {
      console.error('Encrypted message processing failed:', error);
    }
  });

  // The Android app ships its files inside the APK; a service worker there
  // only risks serving stale pages after an update.
  const isNativeApp = Boolean(globalThis.Capacitor?.isNativePlatform?.());

  if (!isNativeApp && 'serviceWorker' in navigator && location.protocol !== 'file:')
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {});

  if (!savedProfile.name) {
    openProfileDialog(true);
  }
}

async function startScan() {
  if (scanning) {
    await bluetooth.stopScan();
    scanning = false;
    $('#scan-button').textContent = 'Start discovery';
    $('#discovery-title').textContent = 'Discovery paused';
    return;
  }
  try {
    const profile = await db.getProfile();
    await bluetooth.startScan(profile.name || 'MeshChat');
    scanning = true;
    $('#scan-button').textContent = 'Stop discovery';
    $('#discovery-title').textContent = 'Looking for devices…';
    $('#discovery-description').textContent =
      'Keep this screen open while MeshChat searches nearby.';
  } catch (error) {
    toast(error.message || 'Bluetooth discovery is unavailable in this browser.');
    $('#discovery-description').textContent =
      'Use the Android app on a supported device to enable native Bluetooth discovery.';
  }
}


async function sendMessage(event) {
  event.preventDefault();

  const text = $('#message-input').value.trim();
  const peerId = chat.activePeerId;
  if (!text || !peerId) return;

  if (!pairing.isSecure(peerId)) {
    toast('Pair and verify this device before sending messages.');
    return;
  }

  // Leave room for JSON and AES-GCM overhead in the BLE packet limit.
  if (new TextEncoder().encode(text).length > 1400) {
    toast('Message is too long for this development build.');
    return;
  }

  const message = await chat.addMessage(peerId, text, 'out', 'queued');
  $('#message-input').value = '';

  await renderMessages();
  renderChatList();

  try {
    await sendSecurePayload(peerId, {
      kind: 'text',
      id: String(message.id),
      text
    });

    // 'delivered' is final, so a receipt that already arrived is kept.
    await chat.updateMessageStatus(message.id, 'sent');
    await renderMessages();
    renderChatList();
    toast('Encrypted message sent. Waiting for receipt…');
  } catch (error) {
    console.error('Encrypted BLE send failed:', error);
    await chat.updateMessageStatus(message.id, 'failed');
    await renderMessages();
    renderChatList();
    toast(error.message || 'Message could not be sent.');
  }
}

async function handleFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast('For this build, local attachments are limited to 10 MB.');
    return;
  }
  await db.saveAttachment({
    name: file.name,
    type: file.type,
    size: file.size,
    createdAt: Date.now(),
  });
  toast(`Attachment "${file.name}" recorded locally. Peer transfer is not enabled yet.`);
  event.target.value = '';
}

async function exportData() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'meshchat-local-data.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function clearData() {
  if (!confirm('Delete all MeshChat local data from this device? This cannot be undone.'))
    return;
  await db.clear();
  pairing.reset();
  identityPromise = null;
  lastPeerSignature = null;
  await chat.load();
  chat.activePeerId = null;
  $('#conversation-panel').classList.add('hidden');
  $('#welcome-panel').classList.remove('hidden');
  await refreshProfile();
  renderChatList();
  renderPeers([]);
  openProfileDialog(true);
  toast('Local data cleared.');
}

init().catch((error) => {
  console.error(error);
  toast(`Startup error: ${error.message}`);
});