# Engineering roadmap

## Phase 1 — Application foundation
- [x] Responsive app shell and navigation
- [x] Local profile, conversations, and message persistence
- [x] Local export and clear-data controls
- [x] ECDH/AES-GCM primitives and tests
- [x] PWA shell and GitHub Actions Android build pipeline

## Phase 2 — Native Android transport
- [ ] Implement Capacitor BLE plugin with GATT server and GATT client
- [ ] Implement explicit runtime permission and Bluetooth state handling
- [ ] Define bounded binary packet framing and fragmentation
- [ ] Add per-peer write queues, acknowledgements, retries, and timeouts
- [ ] Validate on two physical Android devices and multiple Android versions

## Phase 3 — Secure messaging
- [ ] Persistent identity keys using Android Keystore
- [ ] Authenticated peer identity / trust-on-first-use with safety prompts
- [ ] Session key derivation, rotation, and replay protection
- [ ] Encrypted inbound/outbound message protocol
- [ ] Delivery acknowledgements based on remote app acknowledgement

## Phase 4 — Mesh and groups
- [ ] Message TTL, hop count, deduplication, and route policy
- [ ] Store-and-forward queue with expiry and storage quotas
- [ ] Group membership and authenticated group key distribution
- [ ] Relay consent, blocking, and abuse-resistant rate limits

## Phase 5 — Attachments and release
- [ ] Chunked encrypted attachment transfer
- [ ] Wi-Fi Direct / local high-throughput transport evaluation
- [ ] Background operation and battery behavior testing
- [ ] Accessibility, localization, privacy review, threat model
- [ ] Release signing, versioning, crash reporting policy, and final QA

## Acceptance rule

A feature is only marked complete after automated tests and device-level tests appropriate to that feature pass. UI state must never claim a peer is connected or a message delivered based only on a local button click.
