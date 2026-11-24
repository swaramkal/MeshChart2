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
  const wifi = plugin('MeshWifiAware');
  const lora = plugin('MeshMeshtastic');

  return {
    bluetooth: {
      available: Boolean(ble),
      state: ble ? 'native-adapter-present' : 'native-adapter-required',
      label: 'Bluetooth LE',
      detail: ble ? 'Native BLE adapter detected.' : 'Existing BLE plugin is present in Android source; install/build the native app to use it.'
    },
    wifiAware: {
      available: Boolean(wifi),
      state: wifi ? 'native-adapter-present' : 'native-adapter-required',
      label: 'Wi-Fi Aware',
      detail: wifi ? 'Wi-Fi Aware adapter detected.' : 'Requires a dedicated Android Wi-Fi Aware plugin and compatible phones.'
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
    primary: 'wifi-aware',
    fallback: 'bluetooth-audio-profile',
    note: 'Wi-Fi Aware can provide a local IP data path where supported. Bluetooth call audio requires a suitable Bluetooth audio profile; BLE GATT is for control/data, not continuous voice.'
  };
}
