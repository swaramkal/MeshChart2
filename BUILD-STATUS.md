# MeshChat Build Status

Snapshot: Wi-Fi Direct and unified transport implementation source update (2026-11-24)

## Implemented in source

- Existing Vite/Capacitor app shell, local IndexedDB profile/conversations, BLE GATT plugin, secure pairing, AES-GCM secure channel, packet framing, and message acknowledgements retained.
- Native Android `WifiP2pManager` plugin registered in `MainActivity`; DNS-SD identifies MeshChat peers, with local TCP sockets and bounded length-prefixed packet framing.
- JavaScript Wi-Fi Direct adapter and unified transport manager added, with preferred transport selection, per-peer fallback, bounded reconnect attempts, and connection status reporting.
- Application message IDs are saved idempotently to prevent duplicate visible messages across retries.
- Existing relay policy is connected to secure transport callbacks for opaque envelopes; local relay opt-in is persisted and next-hop acknowledgements gate queue removal.
- Voice calls added in source (2026-11-25): `call-service.js` (invite/accept/reject/end, mute, ring timeout, silence watchdog, Wi-Fi-Direct-only), `audio-engine.js`, native `MeshAudioPlugin.java`, RECORD_AUDIO permission, Calls screen and call dialog. Frames are encrypted by the existing secure channel.

## Automated validation performed

- `npm ci`: passed.
- Baseline `npm test`: 61 passed, 0 failed before edits.
- Updated `npm test`: 93 passed, 0 failed (includes 16 new call tests: signalling, busy/reject, permission denied, mute, replay/malformed frames, timeouts, connection loss, BLE refusal, encrypted frame size).
- `npm run build`/Vite not re-run on 2026-11-25 (no network to `npm ci`); the entry point was bundled with esbuild as a syntax/import check only.
- Java was NOT compiled on 2026-11-25 (JRE only, no javac/Android SDK).
- `npm run build`: passed; Vite production bundle generated.
- `npx cap sync android`: passed.
- `cd android && ./gradlew --no-daemon assembleDebug`: blocked before Gradle execution because Java/JDK is missing; Android SDK environment variables and SDK directories are also absent.

## Not verified / remaining limitations

- Native Wi-Fi Direct Java code has not been compiled in this environment; it needs a configured JDK and Android SDK or the preserved Android GitHub Actions workflow.
- No real Android device test was performed. BLE/Wi-Fi Direct interoperability, Android 13–16 permissions, group formation, local TCP sockets, reconnect, and background/power behavior remain unverified.
- Relay can forward only opaque envelopes supplied by an upstream caller. The current chat has no destination-key protocol to create decryptable E2E envelopes for an offline final recipient; do not claim usable multi-hop chat delivery.
- Voice calling is implemented in source only: no real audio has been heard between two phones. Raw PCM (no codec), foreground only, JS-bridge latency unknown.
- No APK was generated in this workspace. The GitHub Actions workflow is preserved but was not run because this ZIP is not connected to the specified GitHub repository and Android build tools are unavailable locally.

This is an engineering snapshot, not a release-ready or device-accepted application. See `docs/WIFI_DIRECT.md` and `docs/TESTING_CHECKLIST.md`.


## Update 2026-11-25 (second pass)

- Multi-hop chat: `e2e.js` seals messages end to end (ephemeral ECDH P-256 -> HKDF -> AES-GCM to the contact's static box key, signed with the sender's pinned ECDSA identity). Box keys are exchanged over the verified pairing channel after each secure connection. `RelayService.originate()` queues the user's own messages even when relay mode is off; relay phones forward blobs they cannot read; the final phone opens, verifies, stores and returns an end-to-end receipt. Relayed text is limited to 400 bytes. Contacts must have connected once after this update (to exchange box keys) before relayed messages work.
- Voice codec: IMA ADPCM (4:1; 163 bytes per 20 ms frame) in `adpcm.js`; frames are independently decodable.
- Background calls: `MeshCallService.java` foreground service (microphone type), wake lock and Wi-Fi lock; manifest permissions added. WebView/JS behaviour with the screen off is unverified.
- Wi-Fi Direct fix: initial enabled state now read from WifiManager, because the P2P state broadcast may not be redelivered.
- New WhatsApp-style theme (CSS only, dark + light).
- Tests: 105 passing (new: e2e-mesh 7, adpcm 5, call-service updates). Three-node A->B->C and A->B->D->C simulations use real WebCrypto. Not compiled: all Java. Not run on phones.
