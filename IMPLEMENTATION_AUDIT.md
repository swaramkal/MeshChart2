# MeshChat Implementation Audit

Audit basis:
1. Uploaded `MeshChart-main (1).zip` source snapshot.
2. The current Termux working-project results and implementation notes shared in this conversation through 2026-11-22.

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

The uploaded `BUILD-STATUS.md` says the Vite production bundle had not been run. In the current working project during this conversation, `npm test` passed 11 tests and `npm run build` passed on 2026-11-22. Update the build report only after preserving the actual command output and commit context.

The uploaded `docs/ROADMAP.md` is a useful starting point, but it does not reflect the newer packet-transport work described in the current working project.

## 3. Current working-project status reported in this conversation

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
