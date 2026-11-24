package com.meshchat.ble;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Iterator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "MeshBle",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        )
    }
)
public class MeshBlePlugin extends Plugin {

    public static final UUID SERVICE_UUID =
        UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e");

    public static final UUID RX_CHAR_UUID =
        UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e");

    public static final UUID TX_CHAR_UUID =
        UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e");

    private static final UUID CCCD_UUID =
        UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner leScanner;
    private BluetoothLeAdvertiser leAdvertiser;
    private BluetoothGattServer gattServer;

    private BluetoothGattCharacteristic serverTxCharacteristic;

    private ScanCallback activeScanCallback;
    private AdvertiseCallback activeAdvertiseCallback;

    private PluginCall pendingAdvertiseCall;
    private String advertisingDisplayName = "MeshChat";

    private final Map<String, BluetoothGatt> activeGatts = new HashMap<>();
    private final Map<String, PluginCall> pendingConnectCalls = new HashMap<>();
    private final Map<String, PluginCall> pendingWriteCalls = new HashMap<>();
    private final Map<String, Integer> negotiatedMtus = new HashMap<>();
    private final Map<String, Integer> serverNegotiatedMtus = new HashMap<>();

    private final Set<String> subscribedDevices = new HashSet<>();

    private final ArrayDeque<PendingNotification> notificationQueue =
        new ArrayDeque<>();
    private boolean notificationInFlight = false;
    private String inFlightNotificationAddress = null;

    private static final class PendingNotification {
        final BluetoothDevice device;
        final String address;
        final byte[] bytes;
        final PluginCall call;
        boolean settled = false;

        PendingNotification(
            BluetoothDevice device,
            byte[] bytes,
            PluginCall call
        ) {
            this.device = device;
            this.address = device.getAddress();
            this.bytes = bytes;
            this.call = call;
        }
    }

    @Override
    public void load() {
        BluetoothManager manager =
            (BluetoothManager) getContext().getSystemService(
                Context.BLUETOOTH_SERVICE
            );

        if (manager != null) {
            bluetoothAdapter = manager.getAdapter();
        }
    }

    private boolean isPermissionGranted(String alias) {
        PermissionState state = getPermissionState(alias);
        return state == PermissionState.GRANTED;
    }

    private boolean hasAndroidBluetoothPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || isPermissionGranted("bluetooth");
    }

    private boolean hasLegacyScanPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || isPermissionGranted("location");
    }

    private void rejectIfPermissionDenied(
        PluginCall call,
        String alias
    ) {
        if (!isPermissionGranted(alias)) {
            call.reject(
                "Bluetooth permission denied. Please grant the required permission."
            );
        }
    }

    private boolean isBluetoothEnabled() {
        return bluetoothAdapter != null && bluetoothAdapter.isEnabled();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();

        boolean bluetoothPermission =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || isPermissionGranted("bluetooth");

        boolean legacyScanPermission =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || isPermissionGranted("location");

        boolean enabled = false;
        boolean supportsScanning = false;
        boolean supportsAdvertising = false;

        try {
            if (bluetoothAdapter != null
                && (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                    || bluetoothPermission)) {
                enabled = bluetoothAdapter.isEnabled();

                if (enabled) {
                    supportsScanning =
                        bluetoothAdapter.getBluetoothLeScanner() != null;
                    supportsAdvertising =
                        bluetoothAdapter.getBluetoothLeAdvertiser() != null;
                }
            }
        } catch (SecurityException ignored) {
            // Permissions are not available yet.
        }

        result.put("enabled", enabled);
        result.put("native", true);
        result.put("supportsScanning", supportsScanning);
        result.put("supportsAdvertising", supportsAdvertising);
        result.put(
            "permissionGranted",
            bluetoothPermission && legacyScanPermission
        );
        result.put(
            "detail",
            enabled
                ? "Android Bluetooth adapter enabled."
                : "Bluetooth is disabled, unavailable, or permission is missing."
        );

        call.resolve(result);
    }

    // ---------------------------------------------------------
    // PERMISSIONS
    // ---------------------------------------------------------

    @PluginMethod
    public void startScan(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!hasAndroidBluetoothPermission()) {
                requestPermissionForAlias(
                    "bluetooth",
                    call,
                    "scanPermissionCallback"
                );
                return;
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!hasLegacyScanPermission()) {
                requestPermissionForAlias(
                    "location",
                    call,
                    "scanPermissionCallback"
                );
                return;
            }
        }

        beginBleScan(call);
    }

    @PermissionCallback
    private void scanPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!hasAndroidBluetoothPermission()) {
                rejectIfPermissionDenied(call, "bluetooth");
                return;
            }
        } else if (!hasLegacyScanPermission()) {
            rejectIfPermissionDenied(call, "location");
            return;
        }

        beginBleScan(call);
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && !hasAndroidBluetoothPermission()) {

            requestPermissionForAlias(
                "bluetooth",
                call,
                "advertisePermissionCallback"
            );
            return;
        }

        beginAdvertising(call);
    }

    @PermissionCallback
    private void advertisePermissionCallback(PluginCall call) {
        if (!hasAndroidBluetoothPermission()) {
            rejectIfPermissionDenied(call, "bluetooth");
            return;
        }

        beginAdvertising(call);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && !hasAndroidBluetoothPermission()) {

            requestPermissionForAlias(
                "bluetooth",
                call,
                "connectPermissionCallback"
            );
            return;
        }

        beginConnect(call);
    }

    @PermissionCallback
    private void connectPermissionCallback(PluginCall call) {
        if (!hasAndroidBluetoothPermission()) {
            rejectIfPermissionDenied(call, "bluetooth");
            return;
        }

        beginConnect(call);
    }

    // ---------------------------------------------------------
    // BLE SCANNING
    // ---------------------------------------------------------

    private void beginBleScan(PluginCall call) {
        if (!isBluetoothEnabled()) {
            call.reject("Bluetooth is not enabled.");
            return;
        }

        try {
            leScanner = bluetoothAdapter.getBluetoothLeScanner();

            if (leScanner == null) {
                call.reject("BLE scanner unavailable.");
                return;
            }

            stopScanInternal();

            activeScanCallback = new ScanCallback() {
                @Override
                public void onScanResult(
                    int callbackType,
                    ScanResult result
                ) {
                    BluetoothDevice device = result.getDevice();

                    if (device == null) return;

                    JSObject peer = new JSObject();

                    peer.put("deviceId", device.getAddress());

                    String name = null;
                    android.bluetooth.le.ScanRecord record =
                        result.getScanRecord();

                    if (record != null) {
                        byte[] advertisedName = record.getServiceData(
                            new ParcelUuid(SERVICE_UUID)
                        );

                        if (advertisedName != null && advertisedName.length > 0) {
                            name = new String(
                                advertisedName,
                                StandardCharsets.UTF_8
                            ).trim();
                        }
                    }

                    if (name == null || name.isEmpty()) {
                        try {
                            name = device.getName();
                        } catch (SecurityException ignored) {
                            name = null;
                        }
                    }

                    peer.put(
                        "username",
                        name != null && !name.trim().isEmpty()
                            ? name.trim()
                            : "MeshPeer"
                    );

                    peer.put("rssi", result.getRssi());

                    notifyListeners("onDeviceDiscovered", peer);
                }

                @Override
                public void onScanFailed(int errorCode) {
                    JSObject event = new JSObject();
                    event.put("code", errorCode);

                    notifyListeners("onScanError", event);
                }
            };

            ScanFilter filter = new ScanFilter.Builder()
                .setServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();

            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(
                    ScanSettings.SCAN_MODE_LOW_LATENCY
                )
                .build();

            leScanner.startScan(
                Collections.singletonList(filter),
                settings,
                activeScanCallback
            );

            call.resolve();

        } catch (SecurityException e) {
            call.reject("Bluetooth scan permission is missing.", e);
        } catch (Exception e) {
            call.reject("Unable to start BLE scanning: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        try {
            stopScanInternal();
            call.resolve();
        } catch (Exception e) {
            call.reject("Unable to stop BLE scanning.", e);
        }
    }

    private void stopScanInternal() {
        if (leScanner != null && activeScanCallback != null) {
            try {
                leScanner.stopScan(activeScanCallback);
            } catch (SecurityException ignored) {
            }

            activeScanCallback = null;
        }
    }

    // ---------------------------------------------------------
    // BLE ADVERTISING AND GATT SERVER
    // ---------------------------------------------------------

    private void beginAdvertising(PluginCall call) {
        if (!isBluetoothEnabled()) {
            call.reject("Bluetooth is not enabled.");
            return;
        }

        try {
            leAdvertiser = bluetoothAdapter.getBluetoothLeAdvertiser();

            if (leAdvertiser == null) {
                call.reject("BLE advertising is not supported.");
                return;
            }

            stopAdvertisingInternal();

            String requestedName = call.getString("displayName");
            advertisingDisplayName = requestedName == null
                ? "MeshChat"
                : requestedName.trim();
            if (advertisingDisplayName.isEmpty()) {
                advertisingDisplayName = "MeshChat";
            }

            pendingAdvertiseCall = call;

            BluetoothManager manager =
                (BluetoothManager) getContext().getSystemService(
                    Context.BLUETOOTH_SERVICE
                );

            if (manager == null) {
                pendingAdvertiseCall = null;
                call.reject("Bluetooth manager unavailable.");
                return;
            }

            gattServer = manager.openGattServer(
                getContext(),
                createGattServerCallback()
            );

            if (gattServer == null) {
                pendingAdvertiseCall = null;
                call.reject("Unable to open GATT server.");
                return;
            }

            BluetoothGattService service = new BluetoothGattService(
                SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY
            );

            BluetoothGattCharacteristic rx =
                new BluetoothGattCharacteristic(
                    RX_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_WRITE
                        | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                    BluetoothGattCharacteristic.PERMISSION_WRITE
                );

            serverTxCharacteristic =
                new BluetoothGattCharacteristic(
                    TX_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ
                        | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                    BluetoothGattCharacteristic.PERMISSION_READ
                );

            BluetoothGattDescriptor cccd =
                new BluetoothGattDescriptor(
                    CCCD_UUID,
                    BluetoothGattDescriptor.PERMISSION_READ
                        | BluetoothGattDescriptor.PERMISSION_WRITE
                );

            serverTxCharacteristic.addDescriptor(cccd);

            service.addCharacteristic(rx);
            service.addCharacteristic(serverTxCharacteristic);

            boolean added = gattServer.addService(service);

            if (!added) {
                pendingAdvertiseCall = null;
                gattServer.close();
                gattServer = null;
                call.reject("Unable to add MeshChat GATT service.");
            }

        } catch (SecurityException e) {
            pendingAdvertiseCall = null;
            call.reject("Bluetooth advertising permission missing.", e);
        } catch (Exception e) {
            pendingAdvertiseCall = null;
            call.reject("Unable to prepare BLE advertising: " + e.getMessage(), e);
        }
    }

    private BluetoothGattServerCallback createGattServerCallback() {
        return new BluetoothGattServerCallback() {

            @Override
            public void onServiceAdded(
                int status,
                BluetoothGattService service
            ) {
                if (!SERVICE_UUID.equals(service.getUuid())) return;

                if (status != BluetoothGatt.GATT_SUCCESS) {
                    rejectPendingAdvertise("GATT service registration failed.");
                    return;
                }

                startAdvertisingNow();
            }

            @Override
            public void onConnectionStateChange(
                BluetoothDevice device,
                int status,
                int newState
            ) {
                if (device == null) return;

                String address = device.getAddress();

                if (newState == BluetoothProfile.STATE_CONNECTED
                    && status == BluetoothGatt.GATT_SUCCESS) {

                    JSObject event = new JSObject();
                    event.put("deviceId", address);

                    notifyListeners("onServerPeerConnected", event);

                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {

                    subscribedDevices.remove(address);
                    cleanupServerNotifications(address);

                    JSObject event = new JSObject();
                    event.put("deviceId", address);

                    notifyListeners("onPeerDisconnected", event);
                }
            }

            @Override
            public void onMtuChanged(BluetoothDevice device, int mtu) {
                if (device != null && mtu >= 23) {
                    serverNegotiatedMtus.put(device.getAddress(), mtu);
                }
            }

            @Override
            public void onCharacteristicWriteRequest(
                BluetoothDevice device,
                int requestId,
                BluetoothGattCharacteristic characteristic,
                boolean preparedWrite,
                boolean responseNeeded,
                int offset,
                byte[] value
            ) {
                if (gattServer == null) return;

                int responseStatus = BluetoothGatt.GATT_SUCCESS;

                int mtu = serverNegotiatedMtus.containsKey(device.getAddress())
                    ? serverNegotiatedMtus.get(device.getAddress()) : 23;
                int maximumPayload = mtu - 3;

                if (!RX_CHAR_UUID.equals(characteristic.getUuid())
                    || preparedWrite
                    || offset != 0
                    || value == null
                    || value.length == 0
                    || value.length > maximumPayload) {

                    responseStatus = BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH;
                } else {
                    emitPacket(device.getAddress(), value);
                }

                if (responseNeeded) {
                    try {
                        gattServer.sendResponse(
                            device,
                            requestId,
                            responseStatus,
                            offset,
                            null
                        );
                    } catch (SecurityException ignored) {
                    }
                }
            }

            @Override
            public void onNotificationSent(
                BluetoothDevice device,
                int status
            ) {
                if (device == null) return;

                PendingNotification completed = null;

                synchronized (notificationQueue) {
                    String callbackAddress = device.getAddress();

                    if (!notificationInFlight
                        || inFlightNotificationAddress == null
                        || !inFlightNotificationAddress.equals(callbackAddress)) {
                        return;
                    }

                    PendingNotification head = notificationQueue.peek();

                    if (head == null || !head.address.equals(callbackAddress)) {
                        return;
                    }

                    completed = notificationQueue.poll();
                    notificationInFlight = false;
                    inFlightNotificationAddress = null;
                }

                if (!completed.settled) {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        completed.call.resolve();
                    } else {
                        completed.call.reject(
                            "BLE notification failed with status " + status + "."
                        );
                    }
                }

                sendNextNotification();
            }

            @Override
            public void onDescriptorWriteRequest(
                BluetoothDevice device,
                int requestId,
                BluetoothGattDescriptor descriptor,
                boolean preparedWrite,
                boolean responseNeeded,
                int offset,
                byte[] value
            ) {
                int status = BluetoothGatt.GATT_SUCCESS;

                if (!CCCD_UUID.equals(descriptor.getUuid())
                    || preparedWrite
                    || offset != 0) {

                    status = BluetoothGatt.GATT_FAILURE;

                } else if (value != null
                    && (value.length == 2)
                    && value[0] == 1
                    && value[1] == 0) {

                    subscribedDevices.add(device.getAddress());

                } else if (value != null
                    && value.length == 2
                    && value[0] == 0
                    && value[1] == 0) {

                    subscribedDevices.remove(device.getAddress());
                    cleanupServerNotifications(device.getAddress());

                } else {
                    status = BluetoothGatt.GATT_FAILURE;
                }

                if (responseNeeded && gattServer != null) {
                    try {
                        gattServer.sendResponse(
                            device,
                            requestId,
                            status,
                            offset,
                            null
                        );
                    } catch (SecurityException ignored) {
                    }
                }
            }
        };
    }

    private void startAdvertisingNow() {
        if (leAdvertiser == null) {
            rejectPendingAdvertise("BLE advertiser unavailable.");
            return;
        }

        try {
            AdvertiseSettings settings =
                new AdvertiseSettings.Builder()
                    .setAdvertiseMode(
                        AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY
                    )
                    .setTxPowerLevel(
                        AdvertiseSettings.ADVERTISE_TX_POWER_HIGH
                    )
                    .setConnectable(true)
                    .build();

            AdvertiseData data =
                new AdvertiseData.Builder()
                    .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                    .build();

            AdvertiseData scanResponse =
                new AdvertiseData.Builder()
                    .addServiceData(
                        new ParcelUuid(SERVICE_UUID),
                        getAdvertisedNameBytes()
                    )
                    .build();

            activeAdvertiseCallback = new AdvertiseCallback() {

                @Override
                public void onStartSuccess(
                    AdvertiseSettings settingsInEffect
                ) {
                    if (pendingAdvertiseCall != null) {
                        pendingAdvertiseCall.resolve();
                        pendingAdvertiseCall = null;
                    }

                    notifyListeners(
                        "onAdvertisingStarted",
                        new JSObject()
                    );
                }

                @Override
                public void onStartFailure(int errorCode) {
                    JSObject event = new JSObject();
                    event.put("code", errorCode);

                    notifyListeners("onAdvertiseError", event);

                    rejectPendingAdvertise(
                        "BLE advertising failed. Error code: " + errorCode
                    );
                }
            };

            leAdvertiser.startAdvertising(
                settings,
                data,
                scanResponse,
                activeAdvertiseCallback
            );

        } catch (SecurityException e) {
            rejectPendingAdvertise("Advertising permission missing.");
        } catch (Exception e) {
            rejectPendingAdvertise(
                "Unable to start advertising: " + e.getMessage()
            );
        }
    }

    private byte[] getAdvertisedNameBytes() {
        String name = advertisingDisplayName == null
            ? "MeshChat"
            : advertisingDisplayName.trim();

        StringBuilder shortened = new StringBuilder();
        int byteCount = 0;

        for (int offset = 0; offset < name.length();) {
            int codePoint = name.codePointAt(offset);
            String character = new String(Character.toChars(codePoint));
            int length = character.getBytes(StandardCharsets.UTF_8).length;

            if (byteCount + length > 12) break;

            shortened.append(character);
            byteCount += length;
            offset += Character.charCount(codePoint);
        }

        if (shortened.length() == 0) {
            return "MeshChat".getBytes(StandardCharsets.UTF_8);
        }

        return shortened.toString().getBytes(StandardCharsets.UTF_8);
    }

    private void rejectPendingAdvertise(String message) {
        if (pendingAdvertiseCall != null) {
            pendingAdvertiseCall.reject(message);
            pendingAdvertiseCall = null;
        }
    }

    @PluginMethod
    public void stopAdvertising(PluginCall call) {
        try {
            stopAdvertisingInternal();
            call.resolve();
        } catch (Exception e) {
            call.reject("Unable to stop advertising.", e);
        }
    }

    private void stopAdvertisingInternal() {
        rejectAllServerNotifications();

        if (leAdvertiser != null && activeAdvertiseCallback != null) {
            try {
                leAdvertiser.stopAdvertising(activeAdvertiseCallback);
            } catch (SecurityException ignored) {
            }

            activeAdvertiseCallback = null;
        }

        if (gattServer != null) {
            try {
                gattServer.close();
            } catch (Exception ignored) {
            }

            gattServer = null;
        }

        serverTxCharacteristic = null;
        subscribedDevices.clear();
    }

    // ---------------------------------------------------------
    // CENTRAL CONNECTION AND SERVICE DISCOVERY
    // ---------------------------------------------------------

    private void beginConnect(PluginCall call) {
        String address = call.getString("deviceId");

        if (address == null || !BluetoothAdapter.checkBluetoothAddress(address)) {
            call.reject("Invalid Bluetooth device address.");
            return;
        }

        if (!isBluetoothEnabled()) {
            call.reject("Bluetooth is not enabled.");
            return;
        }

        if (activeGatts.containsKey(address)) {
            call.reject("A connection to this peer already exists.");
            return;
        }

        try {
            BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);

            BluetoothGatt gatt = device.connectGatt(
                getContext(),
                false,
                createGattCallback(address),
                BluetoothDevice.TRANSPORT_LE
            );

            if (gatt == null) {
                call.reject("Unable to initiate GATT connection.");
                return;
            }

            activeGatts.put(address, gatt);
            pendingConnectCalls.put(address, call);

        } catch (SecurityException e) {
            call.reject("Bluetooth connection permission missing.", e);
        } catch (Exception e) {
            call.reject("Unable to connect: " + e.getMessage(), e);
        }
    }

    private BluetoothGattCallback createGattCallback(String address) {
        return new BluetoothGattCallback() {

            @Override
            public void onConnectionStateChange(
                BluetoothGatt gatt,
                int status,
                int newState
            ) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    rejectPendingConnect(
                        address,
                        "GATT connection failed. Status: " + status
                    );

                    closeGatt(address, gatt);
                    emitDisconnected(address);
                    return;
                }

                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    notifyConnectionEvent(
                        "onPeerConnecting",
                        address
                    );

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        try {
                            if (!gatt.requestMtu(247)) {
                                discoverServices(gatt, address);
                            }
                        } catch (Exception e) {
                            discoverServices(gatt, address);
                        }
                    } else {
                        discoverServices(gatt, address);
                    }

                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {

                    rejectPendingConnect(
                        address,
                        "Peer disconnected before connection setup completed."
                    );

                    rejectPendingWrite(
                        address,
                        "Peer disconnected before packet delivery."
                    );

                    closeGatt(address, gatt);
                    emitDisconnected(address);
                }
            }

            @Override
            public void onMtuChanged(
                BluetoothGatt gatt,
                int mtu,
                int status
            ) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    negotiatedMtus.put(address, mtu);
                }

                discoverServices(gatt, address);
            }

            @Override
            public void onServicesDiscovered(
                BluetoothGatt gatt,
                int status
            ) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    rejectPendingConnect(
                        address,
                        "GATT service discovery failed."
                    );
                    return;
                }

                BluetoothGattService service =
                    gatt.getService(SERVICE_UUID);

                if (service == null) {
                    rejectPendingConnect(
                        address,
                        "MeshChat GATT service not found."
                    );
                    return;
                }

                BluetoothGattCharacteristic rx =
                    service.getCharacteristic(RX_CHAR_UUID);

                BluetoothGattCharacteristic tx =
                    service.getCharacteristic(TX_CHAR_UUID);

                if (rx == null || tx == null) {
                    rejectPendingConnect(
                        address,
                        "MeshChat GATT characteristics are missing."
                    );
                    return;
                }

                try {
                    boolean enabled =
                        gatt.setCharacteristicNotification(tx, true);

                    if (!enabled) {
                        rejectPendingConnect(
                            address,
                            "Unable to enable GATT notifications."
                        );
                        return;
                    }

                    BluetoothGattDescriptor descriptor =
                        tx.getDescriptor(CCCD_UUID);

                    if (descriptor == null) {
                        rejectPendingConnect(
                            address,
                            "GATT notification descriptor missing."
                        );
                        return;
                    }

                    descriptor.setValue(
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    );

                    if (!gatt.writeDescriptor(descriptor)) {
                        rejectPendingConnect(
                            address,
                            "Unable to configure GATT notifications."
                        );
                    }

                } catch (SecurityException e) {
                    rejectPendingConnect(
                        address,
                        "Notification permission missing."
                    );
                }
            }

            @Override
            public void onDescriptorWrite(
                BluetoothGatt gatt,
                BluetoothGattDescriptor descriptor,
                int status
            ) {
                if (!CCCD_UUID.equals(descriptor.getUuid())) return;

                if (status != BluetoothGatt.GATT_SUCCESS) {
                    rejectPendingConnect(
                        address,
                        "Unable to subscribe to peer notifications."
                    );
                    return;
                }

                PluginCall call = pendingConnectCalls.remove(address);

                if (call != null) {
                    JSObject result = new JSObject();
                    result.put("deviceId", address);
                    result.put("connected", true);

                    call.resolve(result);
                }

                notifyConnectionEvent("onPeerConnected", address);
            }

            @Override
            public void onCharacteristicChanged(
                BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic
            ) {
                if (TX_CHAR_UUID.equals(characteristic.getUuid())) {
                    byte[] value = characteristic.getValue();

                    if (value != null) {
                        emitPacket(address, value);
                    }
                }
            }

            @Override
            public void onCharacteristicChanged(
                BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic,
                byte[] value
            ) {
                if (TX_CHAR_UUID.equals(characteristic.getUuid())
                    && value != null) {

                    emitPacket(address, value);
                }
            }

            @Override
            public void onCharacteristicWrite(
                BluetoothGatt gatt,
                BluetoothGattCharacteristic characteristic,
                int status
            ) {
                if (!RX_CHAR_UUID.equals(characteristic.getUuid())) return;

                PluginCall call = pendingWriteCalls.remove(address);

                if (call == null) return;

                if (status == BluetoothGatt.GATT_SUCCESS) {
                    call.resolve();
                } else {
                    call.reject(
                        "GATT packet write failed. Status: " + status
                    );
                }
            }
        };
    }

    private void discoverServices(
        BluetoothGatt gatt,
        String address
    ) {
        try {
            if (!gatt.discoverServices()) {
                rejectPendingConnect(
                    address,
                    "Unable to start GATT service discovery."
                );
            }
        } catch (SecurityException e) {
            rejectPendingConnect(
                address,
                "Bluetooth permission missing during service discovery."
            );
        }
    }

    private void rejectPendingConnect(
        String address,
        String message
    ) {
        PluginCall call = pendingConnectCalls.remove(address);

        if (call != null) {
            call.reject(message);
        }
    }

    private void rejectPendingWrite(
        String address,
        String message
    ) {
        PluginCall call = pendingWriteCalls.remove(address);

        if (call != null) {
            call.reject(message);
        }
    }

    private void closeGatt(
        String address,
        BluetoothGatt gatt
    ) {
        activeGatts.remove(address);
        negotiatedMtus.remove(address);

        try {
            gatt.close();
        } catch (Exception ignored) {
        }
    }

    private void emitDisconnected(String address) {
        notifyConnectionEvent("onPeerDisconnected", address);
    }

    private void notifyConnectionEvent(
        String eventName,
        String address
    ) {
        JSObject event = new JSObject();
        event.put("deviceId", address);

        notifyListeners(eventName, event);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String address = call.getString("deviceId");

        BluetoothGatt gatt =
            address != null ? activeGatts.get(address) : null;

        if (gatt == null) {
            call.resolve();
            return;
        }

        try {
            rejectPendingConnect(address, "Connection cancelled.");
            rejectPendingWrite(address, "Connection closed.");

            gatt.disconnect();
            call.resolve();

        } catch (SecurityException e) {
            call.reject("Bluetooth permission missing.", e);
        }
    }

    // ---------------------------------------------------------
    // PACKET DELIVERY
    // ---------------------------------------------------------

    private void emitPacket(String senderId, byte[] value) {
        if (senderId == null || value == null || value.length == 0) return;

        JSObject event = new JSObject();
        event.put("senderId", senderId);
        event.put("deviceId", senderId);
        event.put("dataBase64", Base64.encodeToString(value, Base64.NO_WRAP));

        notifyListeners("onPacketReceived", event);
    }

    @PluginMethod
    public void writePacket(PluginCall call) {
        String address = call.getString("deviceId");
        String dataBase64 = call.getString("dataBase64");

        if (address == null || dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("Missing deviceId or dataBase64.");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(dataBase64, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid Base64 packet data.", e);
            return;
        }

        if (bytes.length == 0) {
            call.reject("Empty BLE packet.");
            return;
        }

        BluetoothGatt gatt = activeGatts.get(address);
        if (gatt == null) {
            call.reject("Peer is not connected over GATT.");
            return;
        }

        if (pendingWriteCalls.containsKey(address)) {
            call.reject("Another GATT write is already in progress.");
            return;
        }

        int mtu = negotiatedMtus.containsKey(address)
            ? negotiatedMtus.get(address) : 23;
        int maximumPayload = mtu - 3;

        if (bytes.length > maximumPayload) {
            call.reject("Packet exceeds negotiated BLE payload limit of "
                + maximumPayload + " bytes.");
            return;
        }

        BluetoothGattService service = gatt.getService(SERVICE_UUID);
        BluetoothGattCharacteristic rx = service != null
            ? service.getCharacteristic(RX_CHAR_UUID) : null;

        if (rx == null) {
            call.reject("MeshChat GATT RX characteristic not found.");
            return;
        }

        try {
            rx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            rx.setValue(bytes);
            pendingWriteCalls.put(address, call);

            if (!gatt.writeCharacteristic(rx)) {
                pendingWriteCalls.remove(address);
                call.reject("Android rejected the GATT write request.");
            }
        } catch (SecurityException e) {
            pendingWriteCalls.remove(address);
            call.reject("Bluetooth write permission missing.", e);
        } catch (Exception e) {
            pendingWriteCalls.remove(address);
            call.reject("Unable to write BLE packet: " + e.getMessage(), e);
        }
    }

    // Reports the largest payload the link can carry for a peer so the JS
    // layer can size its frames instead of always using 20 bytes.
    // role: "server" for peers that connected to us, otherwise "client".
    @PluginMethod
    public void getMtu(PluginCall call) {
        String address = call.getString("deviceId");

        if (address == null || address.isEmpty()) {
            call.reject("Missing deviceId.");
            return;
        }

        boolean server = "server".equals(call.getString("role"));
        Integer negotiated = server
            ? serverNegotiatedMtus.get(address)
            : negotiatedMtus.get(address);

        int mtu = negotiated != null ? negotiated : 23;

        JSObject result = new JSObject();
        result.put("mtu", mtu);
        result.put("maxPayload", Math.max(20, mtu - 3));
        call.resolve(result);
    }

    @PluginMethod
    public void notifyPacket(PluginCall call) {
        String address = call.getString("deviceId");
        String dataBase64 = call.getString("dataBase64");

        if (address == null || dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("Missing deviceId or dataBase64.");
            return;
        }

        if (gattServer == null || serverTxCharacteristic == null) {
            call.reject("GATT server is not available.");
            return;
        }

        if (!subscribedDevices.contains(address)) {
            call.reject("Peer has not subscribed to notifications.");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(dataBase64, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid Base64 packet data.", e);
            return;
        }

        if (bytes.length == 0) {
            call.reject("Empty BLE packet.");
            return;
        }

        int mtu = serverNegotiatedMtus.containsKey(address)
            ? serverNegotiatedMtus.get(address) : 23;

        if (bytes.length > mtu - 3) {
            call.reject("Packet exceeds negotiated BLE payload limit.");
            return;
        }

        try {
            BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);

            synchronized (notificationQueue) {
                notificationQueue.add(
                    new PendingNotification(device, bytes, call)
                );
            }

            sendNextNotification();

        } catch (SecurityException e) {
            call.reject("Bluetooth notification permission missing.", e);
        } catch (Exception e) {
            call.reject("Unable to queue notification: " + e.getMessage(), e);
        }
    }

    private void sendNextNotification() {
        synchronized (notificationQueue) {
            if (notificationInFlight) return;

            while (!notificationQueue.isEmpty()) {
                PendingNotification pending = notificationQueue.peek();

                if (gattServer == null || serverTxCharacteristic == null) {
                    notificationQueue.poll();
                    if (!pending.settled) {
                        pending.call.reject("GATT server is unavailable.");
                    }
                    continue;
                }

                if (!subscribedDevices.contains(pending.address)) {
                    notificationQueue.poll();
                    if (!pending.settled) {
                        pending.call.reject("Peer notification subscription ended.");
                    }
                    continue;
                }

                try {
                    serverTxCharacteristic.setValue(pending.bytes);
                    notificationInFlight = true;
                    inFlightNotificationAddress = pending.address;

                    boolean initiated = gattServer.notifyCharacteristicChanged(
                        pending.device,
                        serverTxCharacteristic,
                        false
                    );

                    if (initiated) return;

                    notificationInFlight = false;
                    inFlightNotificationAddress = null;
                    notificationQueue.poll();

                    if (!pending.settled) {
                        pending.call.reject(
                            "Android rejected the notification request."
                        );
                    }

                } catch (SecurityException e) {
                    notificationInFlight = false;
                    inFlightNotificationAddress = null;
                    notificationQueue.poll();

                    if (!pending.settled) {
                        pending.call.reject(
                            "Bluetooth notification permission missing.", e
                        );
                    }

                } catch (Exception e) {
                    notificationInFlight = false;
                    inFlightNotificationAddress = null;
                    notificationQueue.poll();

                    if (!pending.settled) {
                        pending.call.reject(
                            "Unable to send notification: " + e.getMessage(), e
                        );
                    }
                }
            }
        }
    }

    private void cleanupServerNotifications(String address) {
        synchronized (notificationQueue) {
            PendingNotification head = notificationQueue.peek();
            Iterator<PendingNotification> iterator =
                notificationQueue.iterator();

            while (iterator.hasNext()) {
                PendingNotification pending = iterator.next();

                if (!pending.address.equals(address)) continue;

                if (pending == head && notificationInFlight) {
                    notificationInFlight = false;
                    inFlightNotificationAddress = null;
                }

                iterator.remove();

                if (!pending.settled) {
                    pending.settled = true;
                    pending.call.reject(
                        "Peer disconnected or unsubscribed during notification."
                    );
                }
            }
        }

        sendNextNotification();
    }

    private void rejectAllServerNotifications() {
        synchronized (notificationQueue) {
            for (PendingNotification pending : notificationQueue) {
                if (!pending.settled) {
                    pending.settled = true;
                    pending.call.reject("GATT server stopped.");
                }
            }

            notificationQueue.clear();
            notificationInFlight = false;
            inFlightNotificationAddress = null;
        }
    }

    // ---------------------------------------------------------
    // LIFECYCLE CLEANUP
    // ---------------------------------------------------------

    @Override
    protected void handleOnDestroy() {
        stopScanInternal();
        stopAdvertisingInternal();

        for (Map.Entry<String, BluetoothGatt> entry :
            new HashMap<>(activeGatts).entrySet()) {

            try {
                entry.getValue().disconnect();
                entry.getValue().close();
            } catch (Exception ignored) {
            }
        }

        activeGatts.clear();
        pendingConnectCalls.clear();
        pendingWriteCalls.clear();
        negotiatedMtus.clear();

        super.handleOnDestroy();
    }
}
