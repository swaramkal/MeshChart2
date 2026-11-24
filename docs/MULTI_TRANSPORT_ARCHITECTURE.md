# MeshChat multi-transport rebuild architecture

## Product direction

MeshChat remains the existing Android-first, offline-first application and repository. This rebuild is an incremental redesign, not a wholesale source-code merge. The current app shell, local database, identity/pairing, secure-channel utilities, packet framing, and Android BLE plugin are preserved.

## Transport roles

| Transport | Purpose | Physical requirements | Current uploaded project status |
|---|---|---|---|
| Bluetooth LE | Nearby discovery, pairing, chat packets, radio-to-phone link | Android BLE | Existing native GATT plugin and JS adapter are present; two-device acceptance is still required |
| Wi-Fi Aware (NAN) | Higher-throughput local peer data path and potential real-time call data path | Both phones must support Android Wi-Fi Aware/NAN | Not implemented in MeshChat |
| Meshtastic over BLE | Phone-to-radio control and LoRa mesh text packets | Compatible Meshtastic radio + BLE | Not implemented in MeshChat |
| Voice calls | Real-time audio sessions / mesh walkie-talkie | Wi-Fi Direct/local IP for live calls; mesh packet voice for walkie-talkie where bandwidth permits | Not implemented |

## Important terminology

Meshtastic is a LoRa-based mesh radio system. It is not LoRaWAN. LoRaWAN normally uses gateways and a network server; Meshtastic devices form a peer mesh. This rebuild targets Meshtastic-compatible radios unless the product requirements are deliberately changed to include a separate LoRaWAN backend.

## Design boundaries

- `BluetoothAdapter` remains the MeshChat peer BLE transport.
- A future `WifiAwareAdapter` must own Android `android.net.wifi.aware.*` APIs in a native plugin, with a JS service facade. Do not emulate Wi-Fi Aware with ordinary Wi-Fi LAN discovery.
- A future `MeshtasticAdapter` must own radio BLE/protobuf framing in a native plugin. Do not send MeshChat's custom packet format directly to a Meshtastic radio.
- `CallController` must use an actual audio media path and call signaling. BLE GATT can exchange call-control messages but is not itself a voice stream.
- All transports feed a common message envelope and local persistence layer, but each transport retains its own MTU, payload, retry, acknowledgement, and permission rules.
- Transport discovery, link establishment, remote application acknowledgement, delivery, and read receipt are distinct states.

## Security and reliability requirements

1. End-to-end encryption for person-to-person messages; relay devices must not see plaintext.
2. Explicit trust verification for peers and clear key-change warnings.
3. Stable message IDs and replay/deduplication protection across transports.
4. Fragment/reassemble only within transport-specific bounded payload limits.
5. A message must not be marked delivered on a local radio/GATT write callback. Require an authenticated remote app acknowledgement when that transport supports one.
6. Meshtastic packet size, airtime, duty-cycle/region rules, channel configuration, and firmware compatibility must be respected. Large attachments and voice calls are not LoRa features.
7. UI must report unavailable hardware, denied permissions, timeout, disconnected, queued, sent-to-radio, and remote-acknowledged states truthfully.

## Calls requirements

- Call setup, ringing, accept/reject, busy, timeout, end, and reconnect state machine.
- Audio focus, microphone permission, speaker/earpiece/Bluetooth route, interruption handling, echo/noise handling, and lifecycle handling.
- Wi-Fi Aware data path negotiation and fallback rules.
- Bluetooth fallback only when a supported audio profile is actually available. Do not imply BLE GATT supports voice.
- Calls are disabled in the UI until the native signaling and media stack pass two-device tests. A mesh walkie-talkie mode is a distinct push-to-talk feature, not a full-duplex call; LoRa is not a suitable general voice-call medium.

## UI changes in this rebuild snapshot

- Added dedicated Calls and LoRa radio navigation sections.
- Added transport explanation cards and explicit “native implementation required” states.
- Added a clear Meshtastic vs LoRaWAN distinction.
- Did not add fake connect/call buttons or simulated connected indicators.

## Implementation order

1. Repair and baseline the existing MeshChat build/tests.
2. Complete Bluetooth BLE transport and two-device acceptance.
3. Implement Wi-Fi Aware native plugin and multi-peer link lifecycle.
4. Implement Meshtastic BLE/protobuf bridge against supported radio firmware.
5. Route normalized encrypted message envelopes over all enabled transports.
6. Implement calls over a real-time IP/audio path, then test supported Bluetooth audio routing.
7. Add store-and-forward and cross-transport deduplication only after transport acknowledgements are reliable.

## Reference projects

- Knit: https://github.com/getknit/knit (study its Wi-Fi Aware + BLE mesh, optional Meshtastic board bridge, live-call / walkie-talkie separation, and subsystem boundaries; do not copy its source wholesale).
- Meshtastic Android: https://github.com/meshtastic/Meshtastic-Android (reference for device onboarding, radio configuration, protobuf protocol, and supported radio workflows).
- Existing MeshChat source and implementation audit are retained in this repository.

This document describes the intended architecture. It does not claim that Wi-Fi Aware, Meshtastic radio, or voice calls are already operational in this snapshot.
