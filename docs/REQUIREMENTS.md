# MeshChat Product and Engineering Requirements

**Product:** MeshChat
**Tagline:** Connect Without Internet.
**Primary platform:** Android
**Core promise:** Nearby users can exchange messages without relying on mobile data, Wi-Fi internet, cloud messaging services, or a hosted backend.

## 1. Product principles

1. Offline-first: core nearby messaging must work without internet access.
2. Local-first: profile, contacts, conversations, and message history are stored on the device.
3. Honest state: never show “sent”, “delivered”, “read”, or “connected” unless the corresponding event has actually occurred.
4. Privacy by design: do not send plaintext through relay devices.
5. User control: relay participation, contact trust, blocking, and data deletion must be user-controlled.
6. Resilient transport: disconnections, retries, duplicate packets, and app restarts must not corrupt message history.
7. Incremental delivery: each stage must pass its acceptance criteria before dependent features are built.

## 2. Onboarding and local profile

- On first launch, require a display name before entering the main app.
- Save the display name locally on the device.
- Use the chosen name as the visible MeshChat name during discovery/advertising where the platform permits.
- Allow the user to change the name in Settings.
- Do not require account registration, email, phone number, or internet access.
- Provide a safe fallback display name only if the user profile is missing or invalid.
- Do not expose private profile data in BLE advertisements. Advertise only the minimum discovery data required.

## 3. Nearby discovery and connections

- Scan for compatible MeshChat BLE service advertisements.
- Advertise the MeshChat service while the device is available to receive connections.
- Show discovered peer name and connection state.
- Handle permission denial, Bluetooth disabled, scan failure, advertising failure, connection timeout, and disconnect.
- Prevent duplicate peer entries for the same device/session.
- Support both connection roles required by the chosen GATT design.
- Stop or reduce scanning when appropriate to avoid excessive battery use.
- Do not treat discovery as proof of a connection.
- Do not treat a GATT connection as proof that a message was delivered.

## 4. Packet transport

- Use a versioned, bounded binary frame format.
- Include enough metadata to identify a packet, fragment, and destination/session.
- Support payload fragmentation based on the negotiated BLE MTU.
- Reassemble out-of-order fragments.
- Ignore exact duplicate fragments safely.
- Reject malformed frames, conflicting duplicate fragments, invalid counts, empty payloads, oversized payloads, and unsupported protocol versions.
- Bound the number and total memory of incomplete packet assemblies.
- Expire incomplete assemblies.
- Isolate assemblies by peer and packet identifier.
- Serialize GATT operations where Android requires it.
- Handle queue backpressure, disconnects, timeouts, and Android callback failures.
- Use application-level acknowledgements; a successful GATT write/notification callback alone is not a recipient delivery acknowledgement.
- Ensure callback handling cannot accidentally complete a newer operation after a disconnect/reconnect race.

## 5. Private messaging and cryptography

- Use a documented, versioned message envelope.
- Use authenticated encryption for message content.
- Authenticate peer identity; encryption alone does not prove who controls a key.
- Store long-term private identity keys securely, preferably using Android Keystore-backed protection.
- Define trust-on-first-use or another explicit peer verification flow, with clear warnings when a peer key changes.
- Derive per-peer session keys using a reviewed key agreement design.
- Define nonce/IV uniqueness rules for AES-GCM.
- Bind protocol version, sender identity, recipient identity, and message ID as authenticated data.
- Add replay protection and persistent deduplication.
- Define session key rotation and recovery behavior.
- Never log plaintext message content, private keys, session keys, or sensitive attachment data.
- Do not claim production-grade end-to-end encryption until the complete protocol is implemented and independently reviewed.

## 6. Message lifecycle and history

- Persist messages and conversations locally.
- Preserve message IDs across retries.
- Distinguish at least: composing, queued locally, transport attempted, accepted by remote app, delivered to recipient device, and read (only if a real read receipt is supported).
- Use remote application acknowledgements for delivery state.
- Retry transient failures with bounded backoff.
- Avoid duplicate visible messages when packets are retried or relayed.
- Provide user controls to export and clear local data.
- Handle storage quotas and corrupted/incomplete records.

## 7. Mesh relay and store-and-forward

- Relay only encrypted envelopes.
- Require explicit opt-in before a device acts as a relay.
- Include a bounded hop count/TTL and expiry time.
- Deduplicate by stable message ID.
- Enforce per-peer and global storage quotas.
- Expire old queued messages.
- Prevent loops and uncontrolled rebroadcast.
- Do not reveal message plaintext or unnecessary sender/recipient metadata to relay nodes.
- Provide controls to pause relay participation and clear relay queue data.
- Define behavior when a recipient is never encountered again.

## 8. Group messaging

- Create and manage groups locally.
- Define group ID, member identities, roles, and membership changes.
- Authenticate group invitations and membership updates.
- Use authenticated group key distribution or a reviewed group key protocol.
- Rotate group keys when membership changes.
- Prevent removed members from decrypting future group messages.
- Deduplicate and order group messages consistently.
- Define how group messages are relayed offline without exposing plaintext.
- Make group delivery status explicit and per-recipient where feasible.

## 9. File and media sharing

- Share selected files only after explicit user action.
- Encrypt file contents before transport.
- Transfer files in bounded chunks with integrity checks.
- Support pause/resume or safe restart after a disconnect.
- Verify the final file hash before marking transfer complete.
- Enforce file-size and storage limits.
- Avoid automatically opening received files.
- Show sender, file name, size, and transfer status.
- Clean up incomplete temporary files safely.

## 10. Notifications and background behavior

- Define Android foreground/background behavior within current platform restrictions.
- Request only necessary runtime permissions and explain why they are needed.
- Avoid promising continuous discovery if Android power management or OS restrictions prevent it.
- Notify users about new messages without exposing message content on the lock screen by default.
- Handle notification permission denial.
- Provide battery-conscious scan and reconnect policies.
- Test process death, app restart, screen lock, and battery saver behavior.
- Do not hide persistent background activity from the user.

## 11. Contacts, trust, and privacy

- Provide a local peer/contact list.
- Show peer identity/trust status clearly.
- Allow rename, remove, block, and unblock actions.
- Prevent blocked peers from sending new messages or initiating unwanted interactions.
- Do not automatically trust a device merely because it is nearby.
- Provide controls for discovery visibility and relay participation.
- Explain what information is stored locally and what is broadcast over BLE.
- Provide a clear local-data deletion/export flow.

## 12. User experience and accessibility

- Keep the interface responsive on common Android screen sizes.
- Provide dark and light themes.
- Use clear empty, loading, error, offline, connecting, connected, and disconnected states.
- Provide accessible labels, contrast, touch targets, and keyboard/screen-reader semantics.
- Support localization-ready strings, including English and Telugu if included in the release scope.
- Do not use decorative status indicators as substitutes for real connection or delivery state.
- Preserve local data across app updates and database schema migrations.

## 13. Engineering and release requirements

- Keep source code and build workflows in the existing GitHub repository.
- Do not introduce Firebase, Supabase, or a cloud messaging backend for core offline messaging.
- Pin and document build requirements.
- Run unit tests and production build on every relevant change.
- Run Android native compilation before accepting native changes.
- Test on at least two physical Android devices with supported Android versions.
- Maintain a threat model and protocol documentation.
- Keep backups before significant source changes.
- Do not delete backups or untracked files without inspection and explicit approval.
- Produce a release checklist, version number, signing plan, and known-limitations list before distribution.
