# MeshChat Implementation Audit

## Current follow-up audit — 2026-11-24

This audit covers the uploaded `MeshChart2-main.zip` plus changes in this workspace. The native Wi-Fi Direct source has not been compiled or device-tested; source presence is not acceptance.

### Existing working foundations
- Vite/Capacitor Android shell, onboarding/profile, local IndexedDB conversations/messages, export/clear, and responsive Chats/Nearby/Calls/Mesh/Settings views.
- Android BLE GATT server/client, discovery/advertising, packet framing/fragmentation, MTU sizing, and JavaScript BLE adapter are present. Automated packet and pairing tests pass; radio interoperability is not verified.
- Pairing uses ephemeral ECDH P-256 + HKDF, a user-compared six-digit code on first contact, ECDSA identity signatures, AES-GCM secure messages, an in-memory replay window, and application message receipts.
- Relay queue policy already had expiry, hop limits, quotas, duplicate suppression, explicit opt-in, and atomic IndexedDB reservation.

### New source in this update
- Native `MeshWifiDirectPlugin.java` uses `WifiP2pManager`, MeshChat DNS-SD name discovery, P2P group negotiation, and bounded framed local TCP sockets. `MainActivity.java` registers it; `AndroidManifest.xml` declares P2P/network and runtime permission requirements.
- `wifi-direct.js` and `transport-manager.js` route BLE and Wi-Fi Direct, prefer Wi-Fi Direct, fall back for known secure peer identities, and use bounded reconnect attempts.
- `relay-transport.js` forwards opaque envelopes inside the existing secure channel and waits for an authenticated next-hop queue acknowledgement. This preserves the current crypto design.
- Incoming message IDs are atomically deduplicated in IndexedDB; persisted `connected` flags are reset on app startup and disconnect.
- The Calls UI remains disabled and explicitly explains that Wi-Fi Direct sockets alone do not implement voice media.

### Unresolved security and product gaps
- The app does not yet have destination-key management or a way to produce a decryptable end-to-end envelope for an offline final recipient. Therefore multi-hop user-message delivery is not complete; relay bridge tests prove only opaque-envelope forwarding policy.
- Device signing keys are non-extractable WebCrypto `CryptoKey` objects in IndexedDB, not protected by Android Keystore; stored chat content is plaintext at rest.
- No secure identity/contact blocking UI, group key protocol, encrypted file transfer, voice signaling/audio, or battery-safe foreground discovery service exists.
- GATT callbacks now check that their `BluetoothGatt` instance is still current before mutating connection state, and per-address map removal is instance-checked. Notification queue ordering and stale callback recovery still require Android device testing. Native runtime permission and background limits need Android 13–16 testing.
- The shell does not include an Android SDK/JDK, so native Java compilation, APK generation, and physical phone testing could not run.

### Automated test coverage
Baseline before code changes was 61 passing tests. The latest suite has 77 passing tests covering existing pairing/crypto/packet/relay policy plus transport choice, send fallback, bounded reconnect, trusted transport aliases, relay bridge acknowledgements, invalid relay source metadata, duplicate visible-message prevention, Wi-Fi profile-name refresh, and socket-loss state updates. These are JavaScript unit tests, not device tests.

### Current required follow-up
Compile with the existing Android GitHub Actions workflow, fix any Java/Android compiler diagnostics, then run the two-phone Wi-Fi Direct/BLE runbook and the three-phone relay acceptance only after destination-key support is implemented. Do not describe the ZIP as complete or release-ready.

Audit basis:
1. Uploaded `MeshChart-main (1).zip` source snapshot.
2. Current workspace source changes and validation through 2026-11-24, plus earlier project notes shared through 2026-11-22.

This is a status audit, not a claim that the app is production-ready.

## 1. Present in the uploaded source ZIP

| Area | Evidence in uploaded ZIP | Assessment |
|---|---|---|
| Web application shell | `index.html`, `src/main.js`, `src/styles.css` | Present |
| Local database | `src/services/database.js`; IndexedDB stores for profile, conversations, messages, attachments | Basic local persistence present |
| Chat model | `src/services/chat.js` | Basic local message/conversation model present |
| Crypto primitives | `src/services/crypto.js`; ECDH P-256 and AES-GCM helpers | Primitives present; not a complete secure messaging protocol |
| Browser BLE adapter | `src/services/bluetooth.js` | Experimental browser adapter present |
| Native Android BLE plugin | `android/app/src/main/java/com/meshchat/ble/MeshBlePlugin.java` | Basic GATT server/client, scanning, advertising, writes/notifications are present in the uploaded snapshot |
| Android project/build files | `android/`, Capacitor files, Gradle wrapper | Present in uploaded ZIP |
| PWA support | `public/manifest.webmanifest`, `public/sw.js` | Present |
| JavaScript tests | `tests/crypto.test.js` | Crypto utility tests present |
| GitHub workflows | `.github/workflows/android-apk.yml`, `deploy.yml` | Present |

## 2. Important documentation mismatches in the uploaded ZIP

The uploaded `README.md` says the native Android BLE plugin is not yet implemented. However, the ZIP contains `MeshBlePlugin.java` with GATT server/client callbacks and BLE operations. The README is therefore stale and should be corrected; do not delete the plugin.

The uploaded README refers to `.github/workflows/android-build.yml`, but the ZIP contains `.github/workflows/android-apk.yml` and `.github/workflows/deploy.yml`. Update the documentation to describe the workflow files that actually exist.

The uploaded `BUILD-STATUS.md` was stale. In this workspace on 2026-11-24, `npm test` passed 77 tests, `npm run build` passed, and `npx cap sync android` passed. Android Gradle/APK compilation remains unverified because Java and Android SDK tools are unavailable.

The uploaded `docs/ROADMAP.md` is a useful starting point, but it does not reflect the newer packet-transport work described in the current working project.

## 3. Historical working-project status reported on 2026-11-22 (superseded by the current follow-up above)

| Feature | Status |
|---|---|
| First-launch display name and local profile | Implemented |
| Display name used in BLE discovery/advertising and editable in Settings | Implemented in the working project; real-device behavior still needs verification |
| BLE scan/advertise/connect foundation | Implemented in source; interoperability not yet verified |
| Packet framing and fragmentation utility | Implemented in working tree |
| Packet transport tests | 11 total tests passed in the working tree |
| JavaScript Bluetooth transport integration | Implemented in working tree |
| Android Base64 packet bridge and MTU validation | Patched in working tree; native compilation not yet verified |
| Serialized Android notification queue | Patched in working tree; native compilation and device behavior not yet verified |
| Late-callback and disconnect recovery edge cases | Requires careful final review and testing |
| ECDH/AES-GCM primitives | Present and unit-tested |
| Persistent cryptographic identity and peer authentication | Not complete |
| Actual encrypted private messaging end-to-end | Not yet accepted as complete |
| Remote application-level delivery acknowledgements | Not complete |
| Mesh relay/store-and-forward | Not implemented |
| Group chat and group key management | Not implemented |
| Encrypted file transfer | Not implemented |
| Reliable background discovery/notifications | Not implemented or not verified |
| Two-device Android end-to-end testing | Not completed |
| Native Android compile after latest local changes | Not completed |

## 4. What “implemented” means

A feature is not complete just because a class, method, screen, or button exists.

A stage can be marked complete only when:
- the implementation is connected to the real app flow;
- invalid and interrupted operations are handled;
- automated tests pass;
- Android build checks pass where native code is involved;
- device-level acceptance checks pass where BLE, notifications, background behavior, or peer interoperability are involved;
- the UI reports only states that have actually been confirmed.

## 5. Current next priority

Finish and verify the native BLE packet transport before building more features on top of it. In particular, review notification queue recovery, callback ordering, disconnect/reconnect behavior, MTU reset, and server lifecycle handling. Then compile the Android app through the existing GitHub Actions workflow and test with two Android devices before moving to the full encrypted messaging stage.
