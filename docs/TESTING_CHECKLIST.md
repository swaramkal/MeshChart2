# MeshChat Testing and Acceptance Checklist

Use this checklist for every stage. Keep the test result, date, Android version, device model, and relevant commit/workflow run with the project.

## A. Project and build

- [ ] Fresh dependency install succeeds.
- [ ] `npm test` succeeds.
- [ ] `npm run build` succeeds.
- [ ] `git diff --check` succeeds.
- [ ] Android GitHub Actions workflow succeeds.
- [ ] Debug APK artifact is generated and can be retrieved.
- [ ] No required source or backup file is missing from the checkout.

## B. Onboarding and profile

- [ ] First launch asks for a display name.
- [ ] Empty/whitespace-only name is rejected or safely handled.
- [ ] Name persists after force-close/reopen.
- [ ] Name can be changed in Settings.
- [ ] Updated name is visible to another device after the expected BLE refresh.
- [ ] No account or internet is required.

## C. BLE discovery and connection

- [ ] Bluetooth disabled state is handled.
- [ ] Permission granted flow works.
- [ ] Permission denied flow is understandable.
- [ ] Device A discovers Device B.
- [ ] Device B discovers Device A where the design expects symmetric discovery.
- [ ] Connection succeeds in both required roles.
- [ ] Disconnect updates UI and peer state.
- [ ] Reconnect succeeds repeatedly.
- [ ] App stop/restart does not leave a false connected state.

## D. Packet transport

- [ ] One-frame packet transfers in each direction.
- [ ] Multi-fragment packet transfers in each direction.
- [ ] Out-of-order fragments reassemble correctly.
- [ ] Identical duplicate fragments are harmless.
- [ ] Conflicting duplicate fragments are rejected.
- [ ] Malformed header and invalid fragment count are rejected.
- [ ] Empty and oversized payloads are rejected.
- [ ] Incomplete assemblies expire.
- [ ] Concurrent peers do not share assembly state.
- [ ] Disconnect during a write/notification settles the operation safely.
- [ ] Reconnect does not let an old callback complete a newer operation.
- [ ] MTU resets correctly on disconnect and new GATT server start.
- [ ] Per-peer queues do not hang indefinitely.
- [ ] Native Android compilation succeeds.

## E. Encryption and private messaging

- [ ] Two devices establish or verify peer identities.
- [ ] Both sides derive compatible session keys.
- [ ] Valid encrypted message decrypts.
- [ ] Modified ciphertext is rejected.
- [ ] Wrong key is rejected.
- [ ] Wrong recipient/session is rejected.
- [ ] Replay is rejected.
- [ ] Nonce/IV uniqueness is enforced.
- [ ] Key change triggers the documented trust warning.
- [ ] No plaintext or private key appears in logs.

## F. Message state and persistence

- [ ] Queued state is distinct from transport attempt.
- [ ] GATT completion is not shown as recipient delivery.
- [ ] Remote app acknowledgement updates delivery state.
- [ ] Duplicate packet does not duplicate visible message.
- [ ] Retry uses stable message identity.
- [ ] Failed/offline message remains visible as failed or queued.
- [ ] Conversation history survives app restart.
- [ ] Export and clear-data actions work as described.

## G. Relay and groups

- [ ] Relay requires explicit opt-in.
- [ ] Relay forwards ciphertext only.
- [ ] Hop limit and expiry are enforced.
- [ ] Duplicate messages are not forwarded indefinitely.
- [ ] Relay quotas are enforced.
- [ ] Three-device relay scenario succeeds.
- [ ] Group invitation and membership updates are authenticated.
- [ ] Group key changes when membership changes.
- [ ] Removed member cannot decrypt later group messages.

## H. File sharing

- [ ] File transfer requires user selection/confirmation.
- [ ] File is encrypted before transport.
- [ ] Chunk ordering and integrity are validated.
- [ ] Interrupted transfer resumes or fails safely.
- [ ] Final hash matches original.
- [ ] Incomplete file is never marked complete.
- [ ] File-size and storage limits are enforced.

## I. Notifications and background

- [ ] Notification permission flow works.
- [ ] Permission denial is handled.
- [ ] Lock-screen content follows privacy setting.
- [ ] Foreground/background behavior matches documented Android support.
- [ ] Screen lock and battery saver behavior are tested.
- [ ] Process death/restart behavior is tested.
- [ ] Battery impact is measured on real devices.

## J. Privacy, accessibility, and release

- [ ] Blocked peer cannot send accepted messages.
- [ ] Discovery visibility setting works.
- [ ] Relay participation can be paused.
- [ ] Local data export/delete works.
- [ ] Screen reader labels are present.
- [ ] Contrast and touch targets are usable.
- [ ] Large text does not break core workflows.
- [ ] Supported Android versions and limitations are documented.
- [ ] Threat model and protocol notes are reviewed.
- [ ] Release version/signing plan is documented.
