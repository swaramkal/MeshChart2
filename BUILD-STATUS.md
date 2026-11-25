# MeshChat Build Status

Snapshot: Wi-Fi Direct and unified transport implementation source update (2026-11-24)

## Implemented in source

- Existing Vite/Capacitor app shell, local IndexedDB profile/conversations, BLE GATT plugin, secure pairing, AES-GCM secure channel, packet framing, and message acknowledgements retained.
- Native Android `WifiP2pManager` plugin registered in `MainActivity`; DNS-SD identifies MeshChat peers, with local TCP sockets and bounded length-prefixed packet framing.
- JavaScript Wi-Fi Direct adapter and unified transport manager added, with preferred transport selection, per-peer fallback, bounded reconnect attempts, and connection status reporting.
- Application message IDs are saved idempotently to prevent duplicate visible messages across retries.
- Existing relay policy is connected to secure transport callbacks for opaque envelopes; local relay opt-in is persisted and next-hop acknowledgements gate queue removal.
- Calls remain explicitly disabled; no call signaling, audio capture/playback, media codec, or encrypted real-time audio has been implemented.

## Automated validation performed

- `npm ci`: passed.
- Baseline `npm test`: 61 passed, 0 failed before edits.
- Updated `npm test`: 77 passed, 0 failed (latest run after transport/name tests).
- `npm run build`: passed; Vite production bundle generated.
- `npx cap sync android`: passed.
- `cd android && ./gradlew --no-daemon assembleDebug`: blocked before Gradle execution because Java/JDK is missing; Android SDK environment variables and SDK directories are also absent.

## Not verified / remaining limitations

- Native Wi-Fi Direct Java code has not been compiled in this environment; it needs a configured JDK and Android SDK or the preserved Android GitHub Actions workflow.
- No real Android device test was performed. BLE/Wi-Fi Direct interoperability, Android 13–16 permissions, group formation, local TCP sockets, reconnect, and background/power behavior remain unverified.
- Relay can forward only opaque envelopes supplied by an upstream caller. The current chat has no destination-key protocol to create decryptable E2E envelopes for an offline final recipient; do not claim usable multi-hop chat delivery.
- Offline voice calling is not implemented. BLE GATT is not a voice transport; Wi-Fi Direct TCP availability alone does not implement audio.
- No APK was generated in this workspace. The GitHub Actions workflow is preserved but was not run because this ZIP is not connected to the specified GitHub repository and Android build tools are unavailable locally.

This is an engineering snapshot, not a release-ready or device-accepted application. See `docs/WIFI_DIRECT.md` and `docs/TESTING_CHECKLIST.md`.
