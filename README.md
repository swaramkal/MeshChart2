# MeshChart2


Android-first offline messenger. This repository preserves the existing MeshChat app, Bluetooth Low Energy foundation, secure pairing, and packet framing, and adds a native Android Wi-Fi Direct/TCP transport plus a unified transport manager. Source and automated tests do not replace two-phone acceptance testing.

## Current implementation status

- App shell, local profile, IndexedDB conversations, secure pairing, AES-GCM message transport, replay window, and BLE GATT plugin are retained.
- Native `WifiP2pManager` discovery uses a MeshChat DNS-SD service record, creates a P2P group, then exchanges bounded length-prefixed packets over local TCP sockets. This code has not been compiled or exercised on Android hardware in this workspace.
- The JavaScript transport manager prefers Wi-Fi Direct, falls back to Bluetooth for the same peer identity where a secure session is available, deduplicates application message IDs, and retries reconnects a bounded number of times.
- The opt-in relay bridge forwards opaque envelopes over the existing authenticated/encrypted peer session and waits for a hop acknowledgement. The chat still lacks a destination encryption-key protocol to create decryptable end-to-end envelopes, so user-message multi-hop delivery is not available.
- JavaScript unit coverage includes transport selection, reconnect, duplicate prevention, relay expiry/hops/quotas/acknowledgements, and Wi-Fi adapter packet events.

## Not yet working / not verified

- End-to-end destination encryption for offline relayed chat messages is not implemented; the relay bridge only forwards envelopes supplied by a caller.
- Voice-call signaling, audio capture/playback, codec, and encrypted media are not implemented. Calls remain disabled; BLE GATT is not an audio path.
- Android compilation is blocked in this workspace because Java/JDK and Android SDK are absent. The GitHub Actions APK workflow was preserved but not run.
- BLE/Wi-Fi Direct interoperability, Android 13–16 permission behavior, reconnect behavior, multi-hop delivery, and real audio have not been tested on physical phones.

## Build locally

```bash
npm ci
npm test
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

## Build APK with GitHub Actions

Push this project to a GitHub repository, then open **Actions → Build MeshChat Android APK → Run workflow**. The workflow runs tests, builds the web bundle, syncs Capacitor, compiles a debug APK, and uploads `meshchat-debug-apk` as a downloadable artifact. A successful workflow proves compilation, not that Bluetooth, Wi-Fi, relay, or calling works between real phones.

## Phone-only workflow

The project can be edited from Termux. If the Android SDK/JDK setup is unavailable on the phone, GitHub Actions can compile the debug APK in the cloud.

Do not describe a transport as operational or a message as delivered unless the native transport and final-recipient acknowledgement confirm it. See `RELEASE-STATUS.txt`, `docs/RELAY.md`, and `docs/TESTING_CHECKLIST.md`.
