/**
 * MeshChat transport capability registry.
 *
 * This file deliberately reports only transports backed by an installed native
 * adapter. It never pretends that a discovered device is connected or that a
 * queued message was delivered.
 */
const plugin = (name) => globalThis.Capacitor?.Plugins?.[name] || null;

export function getTransportCapabilities() {
  const ble = plugin('MeshBle');
  const wifiDirect = plugin('MeshWifiDirect');
  const lora = plugin('MeshMeshtastic');

  return {
    bluetooth: {
      available: Boolean(ble),
      state: ble ? 'native-adapter-present' : 'native-adapter-required',
      label: 'Bluetooth LE',
      detail: ble ? 'Native BLE adapter detected.' : 'Existing BLE plugin is present in Android source; install/build the native app to use it.'
    },
    wifiDirect: {
      available: Boolean(wifiDirect),
      state: wifiDirect ? 'native-adapter-present' : 'native-adapter-required',
      label: 'Wi-Fi Direct',
      detail: wifiDirect ? 'Native Android Wi-Fi Direct adapter detected.' : 'Requires the Android app with the MeshWifiDirect plugin and compatible phones.'
    },
    meshtastic: {
      available: Boolean(lora),
      state: lora ? 'native-adapter-present' : 'native-adapter-required',
      label: 'Meshtastic LoRa',
      detail: lora ? 'Meshtastic bridge detected.' : 'Requires a paired Meshtastic radio and native BLE/protobuf bridge.'
    },
    calls: {
      available: false,
      state: 'not-implemented',
      label: 'Voice calls',
      detail: 'Calls require a real-time audio transport. BLE GATT messaging alone is not an audio-call transport.'
    }
  };
}

export function getCallTransportPlan() {
  return {
    primary: 'wifi-direct-tcp',
    fallback: 'bluetooth-audio-profile',
    note: 'Wi-Fi Direct TCP is the planned local-IP media path. Bluetooth call audio requires a suitable Bluetooth audio profile; BLE GATT is for control/data, not continuous voice.'
  };
}
