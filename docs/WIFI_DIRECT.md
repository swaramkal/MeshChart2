# Native Wi-Fi Direct transport

## What is implemented in source

`android/app/src/main/java/com/meshchat/wifi/MeshWifiDirectPlugin.java` is a Capacitor plugin named `MeshWifiDirect`, registered by `MainActivity`. It uses Android `WifiP2pManager` (Wi-Fi Direct / P2P), DNS-SD service discovery for MeshChat devices, P2P group negotiation, a group-owner TCP listener, and client sockets to the group owner. `src/services/wifi-direct.js` exposes discovery, connection, packet, status, and disconnect events to the app. `src/services/transport-manager.js` combines it with the existing BLE adapter.

The socket protocol uses a 32-bit length prefix followed by a bounded packet (maximum 32 KiB). A first hello exchanges the locally selected display name and public identity fingerprint; actual secure pairing and message validation remain in the existing `PairingController` and `secure-channel.js`. The TCP write completion is a local transport result, not a final-recipient delivery receipt.

Wi-Fi Direct is not Wi-Fi Aware, does not use an internet router, and does not require an internet service. The Android `INTERNET` permission is present only because Android requires it for local TCP sockets. MeshChat does not send core messages to a server.

## Android permissions and limits

- Android 13+ (API 33+): runtime `NEARBY_WIFI_DEVICES` with `neverForLocation` is requested for P2P discovery and connection.
- Android 12L and lower: runtime `ACCESS_FINE_LOCATION` is requested for Wi-Fi Direct discovery. Android may require Location Mode to be enabled; verify on each supported OS/device combination.
- `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`, `CHANGE_NETWORK_STATE`, `ACCESS_NETWORK_STATE`, and `INTERNET` support the P2P and local-socket flow.
- Bluetooth permissions remain separate and follow the existing BLE plugin.
- Discovery currently runs while MeshChat is in use. A foreground service, unattended background discovery, and power-management behavior are not implemented.
- Availability depends on device Wi-Fi Direct hardware, Android vendor behavior, and system settings.

## Verification status

JavaScript tests exercise plugin event mapping, bounded packet serialization, transport choice/fallback, relay acknowledgement policy, and message deduplication. They do not execute `WifiP2pManager`, TCP sockets on Android, radio permissions, or peer interoperability. Android compilation could not be run in the current workspace because no Java/JDK or Android SDK is installed. No physical Android phones were available; do not mark this transport accepted until the two-phone runbook in `TESTING_CHECKLIST.md` passes.

## Manual two-phone runbook

1. Install the same debug APK on two supported Android phones. The current workspace did not produce an APK; build it using the repository's `android-apk.yml` workflow or a configured Android SDK/JDK environment first.
2. Keep Wi-Fi enabled on both phones, turn off mobile data, and do not connect either phone to an internet router. Bluetooth may remain on for fallback tests.
3. Launch MeshChat, choose distinct profile names, and open Nearby devices on both phones. Grant only the requested Bluetooth/Nearby Wi-Fi permissions. On Android 12L and lower, grant location permission and enable Location Mode if Android requires it.
4. Confirm each app lists the other by the selected display name with the Wi-Fi Direct transport label. Connect from one phone; accept/confirm the normal six-digit MeshChat pairing code on both devices.
5. Exchange short and multi-kilobyte encrypted chat messages in both directions, confirm the remote receipt, disconnect and reconnect, then repeat with Bluetooth as a separate transport.
6. Record phone model, Android API level, permissions, whether the router/mobile data were disabled, each direction's result, reconnect result, and relevant logs. Discovery alone is not proof of a connection; TCP write success is not proof of delivery.
