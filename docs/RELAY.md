# MeshChat relay core (implementation status)

`src/services/relay.js` implements a transport-independent store-and-forward policy for encrypted envelopes.

## Implemented and covered by automated tests
- Relay is disabled by default and requires explicit local opt-in.
- Only bounded base64 opaque packet data is accepted; raw text is rejected. The transport caller must provide end-to-end encrypted bytes. The relay validator cannot prove that arbitrary base64 data is ciphertext, so this must be enforced at the message-creation boundary.
- Message IDs are remembered until packet expiry to suppress duplicate broadcasts and loops.
- Packets have bounded expiry and a maximum hop count of eight.
- A forwarding copy decrements the hop count while preserving the ciphertext unchanged.
- Queue item and byte quotas are enforced.
- A queued packet is removed only after the caller confirms successful forwarding.
- The local IndexedDB schema has `relayQueue` and `relaySeen` stores, including expiry cleanup, export, and clear support.

## Not implemented by this module
- Peer discovery, radio transport, route selection, broadcast/unicast delivery, or background execution.
- Native Android scheduling / battery-safe background relay.
- Atomic receive reservation across queue + deduplication stores is implemented for IndexedDB. Forwarding leases / multi-worker claim coordination are still not implemented; avoid running multiple independent forwarders against the same database.
- End-to-end destination decryption and recipient acknowledgement integration.

A native transport must pass an already-encrypted envelope to `receive()`, call `prepareForward()`, send the returned envelope, and call `markForwarded()` only after a transport-level success. A transport success is not proof that the final recipient displayed the message.
