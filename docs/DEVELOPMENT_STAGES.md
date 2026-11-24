# MeshChat Development Stages

Stages are ordered by dependency. Complete and verify each stage before moving to the next. Status reflects the uploaded ZIP plus the current working-project information shared in this conversation on 2026-11-22.

## Stage 0 — Project baseline and documentation

**Status:** Partially complete

### Work
- Preserve the existing `MeshChart` repository and `MeshChat` app identity.
- Reconcile README, build status, workflow names, and roadmap with the actual files.
- Keep a clean baseline backup.
- Document supported Android/Java/Node versions and build commands.

### Acceptance
- README commands match actual workflow files.
- A fresh checkout can install dependencies, run tests, and build the web app.
- Android workflow completes without manual source edits.
- No important untracked or backup files are silently removed.

## Stage 1 — Onboarding and device profile

**Status:** Implemented in the current working project; physical-device verification still required

### Work
- First-launch display-name prompt.
- Local profile persistence.
- Use the chosen name for BLE discovery/advertising where supported.
- Settings screen to change the name.
- Fallback behavior for missing or invalid names.

### Acceptance
- First launch requires a name.
- Force-close/reopen preserves the name.
- Name changes appear correctly to another nearby device after the documented refresh/re-advertise behavior.
- No account or internet connection is required.

## Stage 2 — Native BLE discovery and connection

**Status:** Basic implementation present; device-level acceptance pending

### Work
- Verify Android permissions and Bluetooth state handling.
- Verify scanning and advertising lifecycle.
- Verify both GATT server and GATT client roles.
- Verify service discovery and CCCD subscription.
- Handle disconnect, timeout, duplicate connection, and app shutdown.
- Ensure display-name updates do not disrupt active connections.

### Acceptance
- Two Android devices discover one another.
- Both devices can establish the intended connection roles.
- Disconnect and reconnect work repeatedly.
- Permission denial and Bluetooth-off states produce understandable errors.
- No stale peer is shown as connected.

## Stage 3 — Packet framing, fragmentation, and reliable BLE transport

**Status:** In progress in the current working project

### Work
- Finalize the bounded packet frame and packet-ID rules.
- Fragment payloads to fit the usable negotiated MTU.
- Reassemble out-of-order fragments and reject malformed/conflicting fragments.
- Add per-peer write/notification serialization.
- Review Android callback ordering and queue recovery.
- Clear MTU and connection state on disconnect/server restart.
- Handle stale callbacks safely across disconnect/reconnect and GATT-server generations.
- Add bounded retries, timeouts, and transport-level error reporting.

### Acceptance
- All packet unit tests pass.
- Fragmented packets transfer in both directions between two physical devices.
- Test payloads larger than one BLE frame arrive intact.
- Out-of-order and duplicate fragments do not corrupt messages.
- Disconnect during transfer does not hang queues or mark packets delivered.
- Reconnect does not let a stale callback complete a newer operation.
- Native Android build succeeds.

## Stage 4 — Secure private messaging

**Status:** Crypto primitives exist; end-to-end integration remains

### Work
- Define the versioned encrypted message envelope.
- Persist device identity keys securely.
- Authenticate/verify peer public keys and handle key changes.
- Derive session keys.
- Integrate encryption before transport and decryption after reassembly.
- Add unique nonce rules, authenticated metadata, replay protection, and key rotation.
- Ensure relay-compatible ciphertext envelopes.

### Acceptance
- Two trusted devices exchange encrypted private messages offline.
- Receiver decrypts only with the correct session key.
- Tampered, replayed, malformed, and wrong-recipient messages are rejected.
- Private keys and plaintext are not logged or sent to relay peers.
- Security design receives a documented review before sensitive use.

## Stage 5 — Message lifecycle, acknowledgements, and history

**Status:** Local persistence exists; reliable remote delivery state remains

### Work
- Integrate chat messages with the real transport.
- Add stable message IDs and deduplication.
- Add remote application-level acknowledgements.
- Implement truthful queued/sending/accepted/delivered/failed states.
- Add bounded retries and history reconciliation after app restart.
- Preserve messages and conversations locally.

### Acceptance
- A message appears on the recipient only after it is actually received and validated.
- Sender sees delivered only after a remote application acknowledgement.
- Retry does not create duplicate messages.
- Offline/failed messages remain clearly marked.
- History survives force-close and restart.

## Stage 6 — Mesh relay and store-and-forward

**Status:** Not implemented

### Work
- Add opt-in relay mode.
- Define encrypted relay envelope, hop limit/TTL, expiry, and deduplication.
- Add bounded persistent relay queue and quotas.
- Add routing/forwarding policy and loop prevention.
- Add controls to pause relay and clear queued relay data.

### Acceptance
- A message can travel through an opted-in intermediate device without exposing plaintext.
- Hop limit, expiry, quotas, and deduplication are enforced.
- Relay opt-out prevents forwarding.
- No infinite forwarding loops occur in multi-device tests.

## Stage 7 — Group messaging

**Status:** Not implemented

### Work
- Group creation, invitations, membership, and roles.
- Authenticated group key setup and membership-change key rotation.
- Group message envelope, ordering, deduplication, and delivery status.
- Offline group delivery and relay behavior.

### Acceptance
- Three or more devices exchange group messages offline.
- Only current group members can decrypt new messages.
- Removed members cannot decrypt messages created after removal.
- Duplicate/reordered packets do not create duplicate visible messages.

## Stage 8 — Encrypted file sharing

**Status:** Not implemented; local attachment store alone does not count as file transfer

### Work
- File picker and metadata.
- Encrypt files before transport.
- Chunked transfer with integrity checks.
- Resume/restart behavior after interruption.
- Storage limits and cleanup of incomplete transfers.

### Acceptance
- Two devices transfer a file offline.
- Final file hash matches the original.
- Interrupted transfers recover or fail safely.
- Incomplete files are not presented as completed files.
- Received files are not opened automatically.

## Stage 9 — Notifications and background operation

**Status:** Not implemented or not verified

### Work
- Define foreground service and background limits for supported Android versions.
- Add notification permission handling and privacy controls.
- Add battery-conscious discovery/reconnect strategy.
- Handle app process death, restart, screen lock, and battery saver.

### Acceptance
- New-message notifications work in supported background conditions.
- Permission denial is handled.
- Notification content respects privacy settings.
- App clearly communicates any OS limitation; no false promise of always-on discovery.

## Stage 10 — Contacts, trust, blocking, and privacy controls

**Status:** Not implemented as a complete feature set

### Work
- Local contacts and peer identity display.
- Trust state and key-change warnings.
- Rename/remove/block/unblock.
- Discovery visibility and relay controls.
- Export/delete local data and privacy explanation.

### Acceptance
- Blocked peers cannot initiate accepted messages.
- Trust and identity changes are visible to the user.
- Privacy settings take effect immediately and survive restart.
- Local-data deletion behaves as documented.

## Stage 11 — UI, accessibility, and localization polish

**Status:** Basic responsive UI exists; final review pending

### Work
- Refine loading, empty, error, connection, and message states.
- Verify dark/light themes.
- Improve accessibility labels, contrast, touch targets, and screen-reader behavior.
- Prepare localization-ready text and translations in the agreed release languages.
- Verify small-screen layouts and long names/messages.

### Acceptance
- No misleading connection or delivery indicators.
- Main workflows are usable with screen readers and large text.
- Layout remains usable on supported Android screen sizes.
- All visible controls have working actions.

## Stage 12 — Security, interoperability, and release QA

**Status:** Not complete

### Work
- Review threat model and protocol.
- Test two-device and multi-device scenarios.
- Test reconnect, packet loss, duplicate packets, app restart, and storage exhaustion.
- Run Android build and automated tests from a clean checkout.
- Document supported devices/Android versions and limitations.
- Prepare signing/versioning and release artifact process.

### Acceptance
- All required automated tests pass.
- Native Android build succeeds.
- Required physical-device tests pass.
- Known limitations and permissions are documented.
- No critical security or data-loss issues remain open.
- Release build is reproducible from the repository.

## Stage completion rule

Do not mark a stage complete based only on source code being present. Record:
- implementation commit or change reference;
- automated test results;
- Android build result, if relevant;
- physical-device test result, if relevant;
- unresolved limitations.

A stage with unverified device behavior remains “in progress” or “implemented, awaiting device verification.”
