import './styles.css';
import { MeshDatabase } from './services/database.js';
import { CryptoService } from './services/crypto.js';
import { BluetoothAdapter } from './services/bluetooth.js';
import { WifiDirectAdapter } from './services/wifi-direct.js';
import { TransportManager } from './services/transport-manager.js';
import { ChatController } from './services/chat.js';
import { PairingController } from './services/pairing.js';
import { RelayService } from './services/relay.js';
import { RelayTransportBridge } from './services/relay-transport.js';
import { E2EService, MAX_MESH_TEXT_BYTES } from './services/e2e.js';
import { CallService } from './services/call-service.js';
import { AudioEngine } from './services/audio-engine.js';
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
const bleAdapter = new BluetoothAdapter();
const wifiDirectAdapter = new WifiDirectAdapter();
const bluetooth = new TransportManager({ bluetooth: bleAdapter, wifiDirect: wifiDirectAdapter });
const cryptoService = new CryptoService();
const chat = new ChatController(db);
const relay = new RelayService(db);
const e2e = new E2EService(cryptoService);
const MESH_TTL_MS = 6 * 60 * 60 * 1000;
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
    disconnected: 'Peer disconnected. Pairing was cancelled.',
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

let boxPromise = null;
function getBoxIdentity() {
  boxPromise ||= (async () => {
    let record = await db.getBoxIdentity();
    if (!record) {
      record = await e2e.createBoxIdentity();
      await db.saveBoxIdentity(record);
    }
    return record;
  })().catch((error) => { boxPromise = null; throw error; });
  return boxPromise;
}

async function localFingerprint() {
  return cryptoService.fingerprintOf((await getLocalIdentity()).publicKeySpki);
}

// Handles a sealed message addressed to this device. Returns true if the
// envelope was for us (valid or not), so it is never queued or forwarded.
async function receiveMeshEnvelope(envelope, fromPeerId) {
  const myFingerprint = await localFingerprint();
  if (!e2e.isForMe(envelope?.ciphertext, myFingerprint)) return false;

  let body;
  try {
    body = await e2e.open({
      ciphertext: envelope.ciphertext,
      boxPrivateKey: (await getBoxIdentity()).privateKey,
      myFingerprint,
      lookupIdentityKey: async (fp) => chat.conversations.find((c) => c.fingerprint === fp)?.identityKey || null
    });
  } catch (error) {
    console.warn('Sealed relay message rejected:', error.message);
    return true;
  }

  const contact = chat.conversations.find((c) => c.fingerprint === body.from);
  if (body.k === 'ack') {
    await chat.updateMessageStatus(body.id, 'delivered');
    if (contact && chat.activePeerId === contact.peerId) await renderMessages();
    renderChatList();
  } else if (contact) {
    const received = await chat.addMessage(contact.peerId, body.text, 'in', 'delivered', { messageId: body.id });
    if (!received.duplicate) {
      if (chat.activePeerId === contact.peerId) await renderMessages();
      renderChatList();
    }
    await sendMeshAck(contact, body.id);
  }
  return true;
}

async function sendMeshAck(contact, messageId) {
  if (!contact.boxKey) return;
  try {
    const identity = await getLocalIdentity();
    const ciphertext = await e2e.seal({
      identityPrivateKey: identity.privateKey,
      fromFingerprint: await localFingerprint(),
      toFingerprint: contact.fingerprint,
      recipientBoxKey: contact.boxKey,
      kind: 'ack',
      id: messageId
    });
    const envelope = relay.createEnvelope({ id: `ack_${messageId}`.slice(0, 80), ciphertext, ttlMs: MESH_TTL_MS });
    await relay.originate(envelope);
    await relayBridge.forward();
  } catch (error) {
    console.warn('Could not queue delivery receipt:', error.message);
  }
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

    bluetooth.associateIdentity(peerId, session.remoteFingerprint);
    await db.saveConversation({
      peerId,
      peerName: session.peerName || 'Nearby MeshChat device',
      fingerprint: session.remoteFingerprint,
      identityKey: session.remoteIdentityKey,
      connected: true
    });

    if (previous) {
      // A verified contact can reappear under a different transport address.
      await db.mergeConversation(previous.peerId, peerId);
      if (chat.activePeerId === previous.peerId) chat.activePeerId = peerId;
    }

    await chat.load();
    renderChatList();
    sendSecurePayload(peerId, { kind: 'box-key', key: (await getBoxIdentity()).publicKeySpki })
      .catch((error) => console.warn('Could not share relay key:', error.message));
    await relayBridge.forward();

    if (chat.activePeerId === peerId) {
      $('#conversation-name').textContent = session.peerName || 'Nearby MeshChat device';
      $('#conversation-avatar').textContent = initials(session.peerName || 'Nearby MeshChat device');
      const transport = bluetooth.getConnectionType(peerId);
      const transportLabel = transport === 'wifi-direct' ? 'Wi-Fi Direct' : 'Bluetooth LE';
      $('#conversation-status').textContent = `Secure paired · encrypted chat · ${transportLabel}`;
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
  getDisplayName: async () => (await db.getProfile()).name || 'MeshChat',
  findTrusted: findTrustedContact
});

const relayBridge = new RelayTransportBridge({
  relay,
  getPeers: () => bluetooth.getPeers()
    .filter((peer) => peer.connected && pairing.getSecureSession(peer.id))
    .map((peer) => ({
      ...peer,
      fingerprint: bluetooth.getPeerFingerprint(peer.id) || peer.identityFingerprintHint || peer.id
    })),
  sendEnvelope: (peerId, envelope) => sendSecurePayload(peerId, {
    kind: 'relay-envelope',
    envelope
  }),
  onForwarded: async (messageId) => {
    // Our own message reached the next phone; the final receipt comes end to end.
    const updated = await chat.updateMessageStatus(messageId, 'sent');
    if (updated) { await renderMessages(); renderChatList(); }
  }
});

// Encrypt every chat payload using the key established by verified pairing.
// sealPayload adds a replay counter and binds the sender's role.
async function sendSecurePayload(peerId, payload) {
  const session = pairing.getSecureSession(peerId);
  const packet = await sealPayload(cryptoService, session, payload);
  return bluetooth.send(packet, peerId);
}


const callService = new CallService({
  audio: new AudioEngine(),
  getTransport: (peerId) => bluetooth.getConnectionType(peerId),
  send: (peerId, payload) => sendSecurePayload(peerId, payload)
});

function callEndMessage(reason) {
  return ({
    declined: 'Call declined.',
    busy: 'The other device is busy.',
    'no-answer': 'No answer.',
    missed: 'Missed call.',
    'remote-ended': 'The other person ended the call.',
    'connection-lost': 'Call ended: connection lost.',
    'audio-error': 'Call ended: audio problem.',
    transport: 'The other device is not on Wi-Fi Direct.',
    failed: 'Call could not be started.'
  })[reason] || '';
}

let callClock = null;

function renderCallDialog(state) {
  const dialog = $('#call-dialog');
  if (callClock) { clearInterval(callClock); callClock = null; }

  if (state.state === 'ended') {
    if (dialog.open) dialog.close();
    const message = callEndMessage(state.reason);
    if (message) toast(message);
    return;
  }
  if (state.state === 'idle') {
    if (dialog.open) dialog.close();
    return;
  }

  $('#call-title').textContent = state.peerName || 'Voice call';
  $('#call-avatar').textContent = initials(state.peerName || '?');
  $('#call-accept').classList.toggle('hidden', state.state !== 'incoming');
  $('#call-mute').classList.toggle('hidden', state.state !== 'active');
  $('#call-speaker').classList.toggle('hidden', state.state !== 'active');
  $('#call-mute').textContent = state.muted ? 'Unmute' : 'Mute';
  $('#call-speaker').textContent = state.speaker ? 'Earpiece' : 'Speaker';
  $('#call-end').textContent = state.state === 'incoming' ? 'Decline' : 'End';

  const status = $('#call-status');
  if (state.state === 'outgoing') status.textContent = 'Ringing…';
  else if (state.state === 'incoming') status.textContent = 'Incoming voice call';
  else {
    const tick = () => {
      const secs = Math.floor((Date.now() - state.startedAt) / 1000);
      status.textContent = `Connected · ${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    };
    tick();
    callClock = setInterval(tick, 1000);
  }
  if (!dialog.open) dialog.showModal();
}

function renderCallPeers() {
  const list = $('#call-peer-list');
  if (!list) return;
  const peers = bluetooth.getPeers().filter((peer) =>
    peer.connected && pairing.getSecureSession(peer.id) && bluetooth.getConnectionType(peer.id) === 'wifi-direct');
  $('#call-peer-count').textContent = `${peers.length} device${peers.length === 1 ? '' : 's'}`;
  list.innerHTML = peers.length ? peers.map((peer) => `
    <div class="peer-item call-row">
      <div class="avatar">${escapeHTML(initials(peer.name))}</div>
      <div class="peer-copy"><strong>${escapeHTML(peer.name || 'Nearby device')}</strong><small>Verified · Wi-Fi Direct</small></div>
      <button type="button" class="primary-button" data-call-peer="${escapeHTML(peer.id)}">Call</button>
    </div>`).join('') : '<div class="empty-state">No verified device is connected over Wi-Fi Direct.</div>';
}

async function startVoiceCall(peerId) {
  const peer = bluetooth.getPeers().find((item) => item.id === peerId);
  try {
    await callService.startCall(peerId, peer?.name || chat.getConversation(peerId)?.peerName);
  } catch (error) {
    toast(error.message || 'Could not start the call.');
  }
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

  const activeTransport = bluetooth.getConnectionType(peerId);
  const transportLabel = activeTransport === 'wifi-direct'
    ? 'Wi-Fi Direct'
    : activeTransport === 'bluetooth'
      ? 'Bluetooth LE'
      : 'Nearby';
  $('#conversation-status').textContent = pairing.isSecure(peerId)
    ? `Secure paired · encrypted chat · ${transportLabel}`
    : conversation.connected
      ? `Connected over ${transportLabel} · pairing required`
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
          <small>${escapeHTML(p.transport === 'wifi-direct' ? 'Wi-Fi Direct' : 'Bluetooth LE')}</small>
        </div>
        <span class="peer-signal">${p.connected ? 'Connected' : 'Nearby'}</span>
        <button class="secondary-button connect-peer"
          data-peer="${escapeHTML(p.id)}"
          data-name="${escapeHTML(p.name)}"
          data-transport="${escapeHTML(p.transport || 'bluetooth')}">Connect</button>
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
    name: button.dataset.name,
    transport: button.dataset.transport
  };

  button.disabled = true;

  try {
    const connection = await bluetooth.connect(peer.id, peer.transport);
    const connectedPeerId = connection?.deviceId || peer.id;
    const connectedPeerName = connection?.deviceName || peer.name;
    await db.saveConversation({
      peerId: connectedPeerId,
      peerName: connectedPeerName,
      connected: true
    });
    await chat.load();

    activePairingPeerId = connectedPeerId;
    await pairing.start(connectedPeerId, connectedPeerName);

    renderChatList();
    await openConversation(connectedPeerId);
    toast(`Connected over ${connection?.transport === 'wifi-direct' ? 'Wi-Fi Direct' : 'Bluetooth'}. Securing the connection…`);
  } catch (error) {
    toast(error.message || 'Nearby connection failed.');
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

function renderRelayStatus() {
  const enabled = relay.enabled;
  $('#relay-status').textContent = enabled
    ? 'Opted in locally. This build cannot forward app messages yet.'
    : 'Relay is paused on this device.';
  $('#relay-toggle').textContent = enabled ? 'Pause relay' : 'Enable relay';
  $('#relay-toggle').setAttribute('aria-pressed', String(enabled));
}

async function toggleRelayParticipation() {
  const profile = await db.getProfile();
  const enabled = !relay.enabled;
  await db.saveProfile({ ...profile, relayEnabled: enabled });
  relay.setEnabled(enabled);
  renderRelayStatus();
  if (enabled) await relayBridge.forward();
  toast(enabled ? 'Relay preference saved. Only accepted encrypted envelopes can be forwarded.' : 'Relay participation paused.');
}

function updateTransportStatus(transport, status) {
  const element = transport === 'wifi-direct'
    ? $('#wifi-direct-status')
    : transport === 'bluetooth'
      ? $('#bluetooth-status')
      : null;
  if (!element) return;

  let label = 'Checking';
  if (status?.error) label = 'Action needed';
  else if (status?.state === 'native-adapter-required') label = 'Android app required';
  else if (status?.supported === false || status?.available === false) label = 'Unavailable';
  else if (status?.permissionGranted === false) label = 'Permission needed';
  else if (status?.enabled === false) label = transport === 'wifi-direct' ? 'Wi-Fi off' : 'Bluetooth off';
  else if (status?.enabled === true || status?.available === true) label = 'Ready';
  element.textContent = label;
  element.title = status?.detail || '';
}

async function refreshTransportStatus() {
  const statuses = await bluetooth.getStatus();
  for (const [transport, status] of Object.entries(statuses)) {
    updateTransportStatus(transport, status);
  }
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
  const profile = await refreshProfile();

  try {
    const identity = await getLocalIdentity();
    const fingerprint = await cryptoService.fingerprintOf(identity.publicKeySpki);
    bluetooth.setIdentity({ peerId: fingerprint, fingerprint, displayName: profile.name });
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
  relay.setEnabled(savedProfile.relayEnabled === true);
  renderRelayStatus();
  await chat.load();
  for (const conversation of chat.conversations) {
    if (conversation.connected) {
      await db.saveConversation({ ...conversation, connected: false }, { touch: false });
    }
  }
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
  $('#relay-toggle').addEventListener('click', toggleRelayParticipation);
  $('#export-data').addEventListener('click', exportData);
  $('#clear-data').addEventListener('click', clearData);
  $('#mobile-menu')?.addEventListener('click', () =>
    document.querySelector('.sidebar')?.classList.toggle('mobile-open')
  );
  callService.onState(renderCallDialog);
  $('#call-accept').addEventListener('click', () => callService.accept().catch((e) => toast(e.message)));
  $('#call-end').addEventListener('click', () =>
    callService.getState().state === 'incoming' ? callService.reject() : callService.end());
  $('#call-mute').addEventListener('click', () => callService.setMuted(!callService.getState().muted));
  $('#call-speaker').addEventListener('click', () => callService.setSpeaker(!callService.getState().speaker));
  $('#call-dialog').addEventListener('cancel', (event) => event.preventDefault());
  $('#call-peer-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-call-peer]');
    if (button) startVoiceCall(button.dataset.callPeer);
  });
  document.querySelector('[data-view="calls"]')?.addEventListener('click', renderCallPeers);
  bluetooth.onPeer(() => {
    renderCallPeers();
    schedulePeerRender();
    relayBridge.forward().catch((error) => console.warn('Relay forwarding is unavailable:', error));
  });
  bluetooth.onDisconnect(async (peerId) => {
    callService.handlePeerDisconnect(peerId);
    renderCallPeers();
    const fingerprint = bluetooth.getPeerFingerprint(peerId) ||
      (/^[a-f0-9]{64}$/i.test(String(peerId)) ? String(peerId).toLowerCase() : null);
    const conversation = chat.getConversation(peerId) ||
      chat.conversations.find((item) => item.fingerprint === fingerprint);
    if (!conversation) return;
    await db.saveConversation({ ...conversation, connected: false }, { touch: false });
    await chat.load();
    renderChatList();
    if (chat.activePeerId === conversation.peerId) {
      $('#conversation-status').textContent = 'Saved conversation · not connected';
    }
  });
  bluetooth.onStatus((status) => updateTransportStatus(status.transport, status));
  await refreshTransportStatus();

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
      const session = pairing.getSecureSessionForPacket(peerId, data);
      if (!session) return;
      bluetooth.associateIdentity(peerId, session.remoteFingerprint);

      // Returns null for pairing traffic; throws on forged or replayed data.
      const payload = await openPacket(cryptoService, session, data);
      if (!payload) return;

      if (await callService.handleSignal(peerId, payload, chat.getConversation(peerId)?.peerName)) {
        return;
      }

      if (payload.kind === 'box-key') {
        if (typeof payload.key === 'string' && await e2e.isValidBoxKey(payload.key)) {
          const known = chat.getConversation(peerId);
          if (known) {
            await db.saveConversation({ ...known, boxKey: payload.key }, { touch: false });
            await chat.load();
            await relayBridge.forward();
          }
        }
        return;
      }

      if (payload.kind === 'relay-envelope') {
        if (await receiveMeshEnvelope(payload.envelope, peerId)) {
          await sendSecurePayload(peerId, { kind: 'relay-ack', id: payload.envelope.id });
          return;
        }
        const result = await relayBridge.receive(payload.envelope, peerId);
        if (result.reason === 'queued' || result.reason === 'duplicate') {
          await sendSecurePayload(peerId, {
            kind: 'relay-ack',
            id: payload.envelope.id
          });
        }
        return;
      }

      if (payload.kind === 'relay-ack' && typeof payload.id === 'string') {
        await relayBridge.acknowledge(payload.id, peerId);
        return;
      }

      if (payload.kind === 'ack' && typeof payload.id === 'string') {
        await chat.updateMessageStatus(payload.id, 'delivered');
        if (chat.activePeerId === peerId) await renderMessages();
        renderChatList();
        return;
      }

      if (
        payload.kind !== 'text' ||
        typeof payload.id !== 'string' ||
        payload.id.length < 1 || payload.id.length > 80 ||
        !/^[A-Za-z0-9_-]+$/.test(payload.id) ||
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

      const received = await chat.addMessage(
        peerId,
        payload.text,
        'in',
        'delivered',
        { messageId: payload.id }
      );

      // Send a cryptographically protected receipt to the sender.
      await sendSecurePayload(peerId, {
        kind: 'ack',
        id: payload.id
      });

      if (!received.duplicate) {
        if (chat.activePeerId === peerId) await renderMessages();
        renderChatList();
      }
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
    const identity = await getLocalIdentity();
    const fingerprint = await cryptoService.fingerprintOf(identity.publicKeySpki);
    bluetooth.setIdentity({
      peerId: fingerprint,
      fingerprint,
      displayName: profile.name || 'MeshChat'
    });
    await bluetooth.startScan(profile.name || 'MeshChat');
    scanning = true;
    $('#scan-button').textContent = 'Stop discovery';
    $('#discovery-title').textContent = 'Looking for devices…';
    $('#discovery-description').textContent =
      'Keep this screen open while MeshChat searches nearby.';
  } catch (error) {
    toast(error.message || 'Nearby radio discovery is unavailable here.');
    $('#discovery-description').textContent =
      'Use MeshChat on a supported Android device and enable Bluetooth or Wi-Fi Direct.';
  }
}


async function sendMessage(event) {
  event.preventDefault();

  const text = $('#message-input').value.trim();
  const peerId = chat.activePeerId;
  if (!text || !peerId) return;

  if (!pairing.isSecure(peerId)) {
    const contact = chat.getConversation(peerId);
    if (contact?.boxKey && contact?.fingerprint) {
      await sendViaMesh(contact, text);
    } else {
      toast('Pair and verify this device first. Direct contact is needed once, to exchange keys.');
    }
    return;
  }

  // Keep encrypted envelopes within the current shared secure-channel size cap.
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
    console.error('Encrypted transport send failed:', error);
    await chat.updateMessageStatus(message.id, 'failed');
    await renderMessages();
    renderChatList();
    toast(error.message || 'Message could not be sent.');
  }
}

// Sends to a paired contact who is not connected right now. The message is
// sealed for them end to end and handed to any phones that can carry it.
async function sendViaMesh(contact, text) {
  if (new TextEncoder().encode(text).length > MAX_MESH_TEXT_BYTES) {
    toast(`Relayed messages are limited to ${MAX_MESH_TEXT_BYTES} bytes (about 400 letters).`);
    return;
  }
  const message = await chat.addMessage(contact.peerId, text, 'out', 'queued');
  $('#message-input').value = '';
  await renderMessages();
  renderChatList();
  try {
    const identity = await getLocalIdentity();
    const ciphertext = await e2e.seal({
      identityPrivateKey: identity.privateKey,
      fromFingerprint: await localFingerprint(),
      toFingerprint: contact.fingerprint,
      recipientBoxKey: contact.boxKey,
      kind: 'text',
      id: String(message.id),
      text
    });
    const envelope = relay.createEnvelope({ id: String(message.id), ciphertext, ttlMs: MESH_TTL_MS });
    await relay.originate(envelope);
    toast('Contact is not nearby. Message sealed and waiting for a relay phone.');
    await relayBridge.forward();
  } catch (error) {
    console.error('Mesh send failed:', error);
    await chat.updateMessageStatus(message.id, 'failed');
    await renderMessages();
    renderChatList();
    toast(error.message || 'Message could not be queued.');
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
  relay.setEnabled(false);
  relayBridge.destroy();
  renderRelayStatus();
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
