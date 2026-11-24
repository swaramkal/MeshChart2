// Authenticated, replay-protected message envelopes for a paired session.
//
// Every payload carries a per-direction counter inside the AES-GCM plaintext.
// The sender's role is bound into the additional authenticated data, so a
// message captured while it was being sent cannot be reflected back to its
// sender, and a counter window rejects replays of captured messages.

const PROTOCOL_VERSION = 2;
const MAX_PACKET_BYTES = 2900;
const REPLAY_WINDOW = 64;

function aad(sessionId, senderRole) {
  return `MeshChat message v2:${sessionId}:${senderRole}`;
}

function oppositeRole(role) {
  return role === 'initiator' ? 'responder' : 'initiator';
}

function acceptCounter(session, counter) {
  if (!Number.isSafeInteger(counter) || counter < 1) return false;

  session.receiveHighest = session.receiveHighest || 0;
  session.receiveSeen = session.receiveSeen || new Set();

  if (counter > session.receiveHighest) {
    session.receiveHighest = counter;
  } else if (
    counter <= session.receiveHighest - REPLAY_WINDOW ||
    session.receiveSeen.has(counter)
  ) {
    return false;
  }

  session.receiveSeen.add(counter);

  for (const seen of session.receiveSeen) {
    if (seen <= session.receiveHighest - REPLAY_WINDOW) {
      session.receiveSeen.delete(seen);
    }
  }

  return true;
}

export async function sealPayload(cryptoService, session, payload) {
  if (!session?.sessionId || !session.encryptionKey || !session.role) {
    throw new Error('Secure pairing is required before sending messages.');
  }

  session.sendCounter = (session.sendCounter || 0) + 1;

  const encrypted = await cryptoService.encrypt(
    session.encryptionKey,
    JSON.stringify({ ...payload, n: session.sendCounter }),
    aad(session.sessionId, session.role)
  );

  const packet = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'message',
    sessionId: session.sessionId,
    encrypted
  });

  if (new TextEncoder().encode(packet).length > MAX_PACKET_BYTES) {
    throw new Error('Message is too large for the current Bluetooth transport.');
  }

  return packet;
}

// Returns the decrypted payload, or null when the data is not a message
// packet for this session. Throws if decryption fails or a replay is found.
export async function openPacket(cryptoService, session, data) {
  let packet;

  try {
    packet = JSON.parse(data);
  } catch {
    return null;
  }

  if (
    packet?.v !== PROTOCOL_VERSION ||
    packet.type !== 'message' ||
    !session ||
    packet.sessionId !== session.sessionId
  ) {
    return null;
  }

  const plaintext = await cryptoService.decrypt(
    session.encryptionKey,
    packet.encrypted,
    aad(session.sessionId, oppositeRole(session.role))
  );

  const payload = JSON.parse(plaintext);

  if (!acceptCounter(session, payload?.n)) {
    throw new Error('Replayed or stale message rejected.');
  }

  return payload;
}
