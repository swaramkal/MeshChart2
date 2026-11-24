# Protocol design notes

This document is a design starting point, not a deployed wire protocol.

## Proposed frame

A production packet should include: protocol version, packet type, message UUID, sender identity fingerprint, recipient/group identifier, creation time, expiry, hop limit, sequence number, payload length, and authenticated payload.

All length fields must be bounded before allocation. Reject malformed frames, duplicate message IDs, expired packets, unsupported versions, and packets exceeding configured quotas.

## BLE constraints

BLE characteristic writes and notifications have small payload limits that vary with negotiated MTU and platform behavior. MeshChat must fragment larger application packets, serialize GATT operations per connection, reassemble with strict memory/time limits, and acknowledge at the application layer. A successful GATT write callback is not proof that a recipient displayed a message.

## Security requirements

- Authenticate peer keys; encryption alone does not establish identity.
- Use a unique nonce/IV for every AES-GCM encryption under a given key.
- Bind sender, recipient, message ID, and protocol version as authenticated data.
- Prevent replay with persistent sequence tracking and message-ID deduplication.
- Never relay plaintext.
- Require explicit user consent before participating as a relay.

## Implemented in v2 (direct one-to-one chat)

This section describes what the code actually does today. Mesh relay is not implemented.

### Device identity
Each install creates one ECDSA P-256 identity key on first launch. The private key is non-extractable and stored in IndexedDB; the SHA-256 of the public key (SPKI) is the device fingerprint. Clearing local data deletes it.

### Pairing handshake (pairing.js)
1. `hello` (initiator) and `ack` (responder) carry a fresh ephemeral ECDH P-256 key, a random nonce, and the sender's identity public key.
2. Both sides hash a transcript of both ephemeral keys, both nonces, and both identity keys, then derive an AES-256-GCM key, a confirmation key, and a 6-digit code with ECDH + HKDF.
3. First contact: both users compare the 6-digit code and confirm.
4. `confirm` carries an HMAC (proves both derived the same keys) and an ECDSA signature over the transcript hash with the sender's identity key (proves who the sender is).
5. When both confirmations verify, the remote fingerprint is stored on the conversation (pinned).
6. Later pairings with a pinned fingerprint are confirmed automatically, even from a new Bluetooth address. An impostor cannot sign the transcript, so it fails at step 4.

If a confirmation arrives before the receiver finished deriving keys, it is held and processed afterwards.

### Messages (secure-channel.js)
- AES-256-GCM, random 96-bit IV per message.
- Authenticated data: `MeshChat message v2:<sessionId>:<sender role>`. The sender role stops a captured message being reflected back to its sender.
- A per-direction counter inside the encrypted payload is checked against a 64-message window to reject replays while tolerating small reordering.
- Delivery receipts (`ack`) use the same envelope.

### Transport (packet-transport.js)
Frames have an 8-byte header. The sender sizes frames from the negotiated MTU (`MeshBle.getMtu`, up to 255 bytes) and falls back to 20 bytes. Receivers accept frames up to 255 bytes.

### Not done yet
- Stored chats are not encrypted at rest. Protecting them properly needs an Android Keystore-backed key (native code).
- No relay, store-and-forward, groups, or file transfer.
- BLE addresses can still change between sessions; the pinned identity is what links them.
