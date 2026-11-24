# MeshChat Build Status

Snapshot: multi-transport UI/architecture rebuild

## Present in this ZIP
- Existing MeshChat web/Capacitor project and Bluetooth BLE code retained.
- Calls and Mesh Network navigation sections added; no external LoRa radio is required.
- Multi-transport architecture and staged integration requirements added.
- Calls/LoRa UI explicitly reports native implementation requirements; no fake operational controls are exposed.

## Not yet implemented / not verified
- Native Wi-Fi Aware (NAN) transport.
- Cross-transport message routing and acknowledgements.
- Voice call signaling and audio media.
- Two-device BLE acceptance and native Android compilation for this rebuilt snapshot.

Do not describe this ZIP as a complete working Wi-Fi + Bluetooth + LoRa + calling release until all relevant checks in `TESTING_CHECKLIST.md` pass on real hardware.


## 2026-11-24 implementation update

- Added `src/services/relay.js` with opt-in, bounded opaque packet envelopes, expiry, hop limits, deduplication, queue quotas, and forwarding acknowledgement lifecycle. The caller must supply end-to-end encrypted packet bytes; the relay layer cannot prove arbitrary base64 data is ciphertext.
- Added IndexedDB schema v3 relay queue and deduplication stores.
- Added `docs/RELAY.md` and a GitHub Actions Android debug APK workflow.
- Automated JavaScript tests: 61 passed, 0 failed.
- Added atomic IndexedDB relay packet reservation across `relayQueue` and `relaySeen`; this closes duplicate-arrival and queue-quota races between concurrent receive callbacks. A concurrency regression test passes. JavaScript syntax checks passed.
- `npm run build` remains unverified locally because Vite is not installed in the current workspace. `npm ci` timed out in this environment.
- Relay is not integrated with BLE/Wi-Fi transports; multi-hop phone-to-phone relay is not operational. Wi-Fi Direct/Aware and voice calling remain unimplemented.

- Replaced the old LoRa radio screen with a Mesh Network screen describing Bluetooth relay, offline Wi-Fi, and store-and-forward status without implying they are operational.
