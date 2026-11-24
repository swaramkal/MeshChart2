# MeshChart2


Android-first offline messenger. This repository contains the existing MeshChat app, its Bluetooth Low Energy foundation, secure pairing code, packet framing, and a newly added transport-independent relay policy module.

## Current verified source status

- App shell, local profile/storage, pairing, and secure-channel code are present.
- Native Android BLE GATT plugin and JavaScript BLE adapter are present in source; real-device interoperability still needs testing.
- Packet framing and fragmentation utilities are present and unit-tested.
- Relay policy core is implemented and unit-tested: explicit opt-in, bounded opaque packet envelopes (the caller must supply end-to-end ciphertext), expiry, hop limits, deduplication, queue quotas, and forwarding acknowledgement lifecycle.
- IndexedDB schema v3 includes persistent relay queue and deduplication stores.
- A GitHub Actions workflow builds a debug APK after tests pass.

## Not yet working / not verified

- Relay core is not connected to BLE or Wi-Fi transports, so multi-hop phone-to-phone relay is not operational.
- Native Wi-Fi Direct / Wi-Fi Aware transport is not implemented.
- Offline voice-call signaling and audio are not implemented.
- The latest Android APK workflow has not yet been run in GitHub Actions.
- Two-device Android acceptance testing has not been completed.

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
