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

## J. Two-phone and three-phone runbook

The test below must be run on physical Android phones; JavaScript tests cannot emulate radio discovery, permission dialogs, Wi-Fi Direct group negotiation, audio devices, or Android background policy.

### Install and two-phone direct messaging
1. Build a debug APK with the repository's `android-apk.yml` workflow (the current workspace could not produce one because it lacks a JDK and Android SDK), download the artifact, and install the same APK on two phones. Android may require enabling “Allow from this source” for the app used to open the APK; disable that allowance after installation if desired.
2. On both phones, launch MeshChat and set different display names. Keep Wi-Fi and Bluetooth enabled, but turn off mobile data and avoid connecting to an internet router. Wi-Fi Direct needs Wi-Fi radio enabled, not an internet connection.
3. Open Nearby devices. Grant Bluetooth permissions when BLE is tested. For Wi-Fi Direct grant Nearby Wi-Fi Devices on Android 13+; on Android 12L and lower grant Fine Location and enable Location Mode if required by the OS.
4. Confirm each phone lists the other under the user-selected name and transport label. Connect, compare the six-digit code in person, and confirm on both phones.
5. Exchange messages in both directions, including a short message and a message larger than one radio frame. Confirm the sender changes to “delivered” only after the receiver app acknowledges it. Disconnect, reconnect, repeat, and record Android version/model, radio, and outcome.
6. Repeat with Bluetooth selected. Do not assume a Wi-Fi result validates BLE, or vice versa.

### Three-phone relay limitation
The relay policy and secure next-hop bridge have automated tests, but the application does not yet create destination-decryptable envelopes for offline recipients. Do not report Phone A → Phone B → Phone C app-message delivery as passing; the current release has no usable origin-to-destination relay key flow. Once implemented, test A and C paired first, put B between them, opt B into relay, keep all phones offline from the internet, then verify ciphertext is forwarded and only C displays plaintext. Also test relay opt-out, duplicate envelopes, expiry, and hop exhaustion.

### Voice limitation
Voice-call UI remains disabled. No two-way voice test can pass in this build because call signaling and media capture/playback have not been implemented. Do not count BLE packets or a Wi-Fi socket connection as audio transmission.

## K. Privacy, accessibility, and release

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


## Voice call test (two phones, Wi-Fi/mobile data OFF, airplane mode + Wi-Fi on is fine)
1. Install the APK on both phones; set different display names; grant Nearby devices and Microphone when asked.
2. Nearby devices -> Start discovery on both -> connect over Wi-Fi Direct -> confirm the same 6-digit code on both.
3. Calls tab on phone A -> tap Call next to phone B. Phone B must show Incoming voice call.
4. Accept. Speak on A, listen on B, then reverse. Record: audible both ways? delay? choppy?
5. Test Mute, Speaker, End from each side; reject a call; let a call ring 30 s (no answer).
6. Switch off Wi-Fi on B mid-call: A must end with 'connection lost' within ~8 s.
Report exact results; do not mark the feature accepted unless audio was heard in both directions.
