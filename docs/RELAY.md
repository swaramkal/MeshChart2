# MeshChat relay core (implementation status)

`src/services/relay.js` implements the bounded store-and-forward policy. `src/services/relay-transport.js` connects it to secure peer message callbacks and the unified transport manager for opaque envelopes.

## Implemented and covered by automated tests
- Relay is disabled by default and requires explicit local opt-in.
- Only bounded base64 opaque packet data is accepted; raw text is rejected. The transport caller must provide end-to-end encrypted bytes. The relay validator cannot prove that arbitrary base64 data is ciphertext, so this must be enforced at the message-creation boundary.
- Message IDs are remembered until packet expiry to suppress duplicate broadcasts and loops.
- Packets have bounded expiry and a maximum hop count of eight.
- A forwarding copy decrements the hop count while preserving the ciphertext unchanged.
- Queue item and byte quotas are enforced.
- A queued packet is removed only after the caller confirms successful forwarding.
- The local IndexedDB schema has `relayQueue` and `relaySeen` stores, including expiry cleanup, export, and clear support.

## Current transport integration and limitations
- `RelayTransportBridge` accepts a relay envelope only after the outer packet has passed the existing secure-channel authentication. It excludes the incoming hop, forwards unchanged opaque ciphertext to one other connected, secure peer, and waits for that peer's encrypted queue acknowledgement before removing the local packet.
- The next-hop acknowledgement proves that the peer accepted or already had the envelope in its local queue; it is not proof of final-recipient delivery or display.
- The chat does not yet create destination-decryptable end-to-end envelopes for offline recipients. A direct BLE/Wi-Fi chat's session key is not a durable destination key for a disconnected peer. Therefore app-originated multi-hop message delivery is not available, despite the transport bridge and policy tests.
- Native Android scheduling, battery-safe background relay, durable forwarding leases, and multi-worker claim coordination are not implemented. Keep one forwarding bridge per app instance.
- Relay opt-in is stored in the local profile and is off by default. It can be paused from the Mesh Network screen.

The bridge sends relayed packets inside the existing per-hop secure channel; it does not introduce a second encryption scheme and never decrypts the inner ciphertext.
