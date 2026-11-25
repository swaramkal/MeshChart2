package com.meshchat.wifi;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pDeviceList;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "MeshWifiDirect",
    permissions = {
        @Permission(
            alias = "nearbyWifi",
            strings = { Manifest.permission.NEARBY_WIFI_DEVICES }
        ),
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_FINE_LOCATION }
        )
    }
)
public class MeshWifiDirectPlugin extends Plugin {
    private static final int SOCKET_PORT = 43871;
    private static final int MAX_PACKET_BYTES = 32 * 1024;
    private static final String SERVICE_INSTANCE_NAME = "meshchat";
    private static final String SERVICE_TYPE = "_meshchat._tcp";
    private static final long CONNECT_TIMEOUT_MS = 45_000L;

    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private BroadcastReceiver receiver;
    private boolean receiverRegistered;
    private boolean p2pEnabled;
    private volatile boolean groupFormed;
    private boolean discovering;
    private volatile boolean clientConnecting;
    private volatile boolean socketServerStarting;
    private boolean localServiceRegistered;
    private boolean serviceRequestRegistered;
    private WifiP2pDnsSdServiceInfo localService;
    private WifiP2pDnsSdServiceRequest serviceRequest;
    private final Map<String, String> meshChatNames = new ConcurrentHashMap<>();

    private volatile String localPeerId = "";
    private volatile String localDisplayName = "MeshChat";
    private String registeredDisplayName;
    private volatile String localFingerprint = "";
    private volatile PluginCall pendingConnectCall;
    private volatile ServerSocket serverSocket;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();
    private final Map<String, PeerSocket> sockets = new ConcurrentHashMap<>();

    private static final class PeerSocket {
        final Socket socket;
        final DataInputStream input;
        final DataOutputStream output;
        volatile String peerId;
        volatile String displayName;
        volatile String fingerprint;
        volatile boolean closed;

        PeerSocket(Socket socket) throws IOException {
            this.socket = socket;
            this.input = new DataInputStream(socket.getInputStream());
            this.output = new DataOutputStream(socket.getOutputStream());
        }
    }

    @Override
    public void load() {
        manager = (WifiP2pManager) getContext().getSystemService(Context.WIFI_P2P_SERVICE);
        if (manager == null) return;

        channel = manager.initialize(getContext(), getContext().getMainLooper(),
            () -> emitError("channel", "Wi-Fi Direct channel was lost. Restart discovery."));
        if (channel == null) return;

        manager.setDnsSdResponseListeners(channel,
            (instanceName, registrationType, device) -> {
                if (device == null || !SERVICE_INSTANCE_NAME.equalsIgnoreCase(instanceName)) return;
                emitDiscovered(device.deviceAddress,
                    meshChatNames.getOrDefault(device.deviceAddress, cleanName(device.deviceName)),
                    device.status);
            },
            (fullDomain, record, device) -> {
                if (device == null || !"1".equals(record.get("version"))) return;
                String advertisedName = record.get("name");
                String name = advertisedName == null
                    ? cleanName(device.deviceName)
                    : cleanName(advertisedName);
                meshChatNames.put(device.deviceAddress, name);
                emitDiscovered(device.deviceAddress, name, device.status);
            });

        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION);
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION.equals(action)) {
                    p2pEnabled = intent.getIntExtra(
                        WifiP2pManager.EXTRA_WIFI_STATE,
                        WifiP2pManager.WIFI_P2P_STATE_DISABLED
                    ) == WifiP2pManager.WIFI_P2P_STATE_ENABLED;
                    emitStatus();
                } else if (WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(action)) {
                    requestPeers();
                } else if (WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(action)) {
                    requestConnectionInfo();
                }
            }
        };
        ContextCompat.registerReceiver(
            getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        );
        receiverRegistered = true;
    }

    private boolean hasPermissionAlias(String alias) {
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private boolean hasRequiredPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? hasPermissionAlias("nearbyWifi")
            : Build.VERSION.SDK_INT < Build.VERSION_CODES.M || hasPermissionAlias("location");
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", manager != null && getContext().getPackageManager()
            .hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT));
        result.put("enabled", p2pEnabled);
        result.put("permissionGranted", hasRequiredPermission());
        result.put("discovering", discovering);
        result.put("groupFormed", groupFormed);
        result.put("connectedPeers", sockets.size());
        result.put("detail", manager == null
            ? "This device does not expose Android Wi-Fi Direct."
            : p2pEnabled
                ? "Wi-Fi Direct is available for local peer connections."
                : "Wi-Fi Direct is disabled or unavailable.");
        call.resolve(result);
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!hasPermissionAlias("nearbyWifi")) {
                requestPermissionForAlias("nearbyWifi", call, "discoveryPermissionCallback");
                return;
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !hasPermissionAlias("location")) {
            requestPermissionForAlias("location", call, "discoveryPermissionCallback");
            return;
        }
        beginDiscovery(call);
    }

    @PermissionCallback
    private void discoveryPermissionCallback(PluginCall call) {
        if (!hasRequiredPermission()) {
            call.reject("Nearby Wi-Fi permission is required for Wi-Fi Direct discovery.");
            return;
        }
        beginDiscovery(call);
    }

    private void beginDiscovery(PluginCall call) {
        if (manager == null || channel == null) {
            call.reject("Wi-Fi Direct is not supported on this device.");
            return;
        }
        if (!p2pEnabled) {
            call.reject("Turn on Wi-Fi to use Wi-Fi Direct. An internet router is not required.");
            return;
        }

        String requestedName = call.getString("displayName");
        String requestedId = call.getString("peerId");
        String requestedFingerprint = call.getString("fingerprint");
        localDisplayName = cleanName(requestedName);
        if (requestedId != null && !requestedId.isEmpty()) localPeerId = requestedId;
        if (requestedFingerprint != null) localFingerprint = requestedFingerprint;

        try {
            registerLocalService(call);
        } catch (SecurityException error) {
            call.reject("Nearby Wi-Fi permission is missing.", error);
        } catch (Exception error) {
            call.reject("Unable to register MeshChat Wi-Fi Direct discovery.", error);
        }
    }

    private void registerLocalService(PluginCall call) {
        if (localServiceRegistered && localDisplayName.equals(registeredDisplayName)) {
            registerServiceRequest(call);
            return;
        }
        if (localServiceRegistered && localService != null) {
            manager.removeLocalService(channel, localService, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { localServiceRegistered = false; addLocalService(call); }
                @Override public void onFailure(int reason) { localServiceRegistered = false; addLocalService(call); }
            });
            return;
        }
        addLocalService(call);
    }

    private void addLocalService(PluginCall call) {
        Map<String, String> record = new HashMap<>();
        record.put("version", "1");
        record.put("name", localDisplayName);
        localService = WifiP2pDnsSdServiceInfo.newInstance(
            SERVICE_INSTANCE_NAME, SERVICE_TYPE, record
        );
        manager.addLocalService(channel, localService, new WifiP2pManager.ActionListener() {
            @Override
            public void onSuccess() {
                localServiceRegistered = true;
                registeredDisplayName = localDisplayName;
                registerServiceRequest(call);
            }

            @Override
            public void onFailure(int reason) {
                call.reject("Unable to advertise MeshChat over Wi-Fi Direct (" + reason + ").");
            }
        });
    }

    private void registerServiceRequest(PluginCall call) {
        if (serviceRequestRegistered) {
            startServiceDiscovery(call);
            return;
        }
        serviceRequest = WifiP2pDnsSdServiceRequest.newInstance(SERVICE_TYPE);
        manager.addServiceRequest(channel, serviceRequest, new WifiP2pManager.ActionListener() {
            @Override
            public void onSuccess() {
                serviceRequestRegistered = true;
                startServiceDiscovery(call);
            }

            @Override
            public void onFailure(int reason) {
                call.reject("Unable to register the MeshChat Wi-Fi Direct discovery request (" + reason + ").");
            }
        });
    }

    private void startServiceDiscovery(PluginCall call) {
        manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
            @Override
            public void onSuccess() {
                manager.discoverServices(channel, new WifiP2pManager.ActionListener() {
                    @Override
                    public void onSuccess() {
                        discovering = true;
                        emitStatus();
                        call.resolve();
                    }

                    @Override
                    public void onFailure(int reason) {
                        call.reject("MeshChat service discovery failed (" + reason + "). Check Wi-Fi and location services.");
                    }
                });
            }

            @Override
            public void onFailure(int reason) {
                call.reject("Wi-Fi Direct peer discovery failed (" + reason + "). Check Wi-Fi and location services.");
            }
        });
    }

    @PermissionCallback
    private void connectPermissionCallback(PluginCall call) {
        if (!hasRequiredPermission()) {
            call.reject("Nearby Wi-Fi permission is required to connect to a peer.");
            return;
        }
        beginConnect(call);
    }

    @PluginMethod
    public void updateIdentity(PluginCall call) {
        localDisplayName = cleanName(call.getString("displayName"));
        localPeerId = safeValue(call.getString("peerId"), localPeerId);
        localFingerprint = safeValue(call.getString("fingerprint"), localFingerprint);
        if (!discovering || !p2pEnabled || !localServiceRegistered) {
            call.resolve();
            return;
        }
        try {
            registerLocalService(call);
        } catch (SecurityException error) {
            call.reject("Nearby Wi-Fi permission is missing.", error);
        } catch (Exception error) {
            call.reject("Unable to refresh MeshChat Wi-Fi Direct identity.", error);
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!hasPermissionAlias("nearbyWifi")) {
                requestPermissionForAlias("nearbyWifi", call, "connectPermissionCallback");
                return;
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !hasPermissionAlias("location")) {
            requestPermissionForAlias("location", call, "connectPermissionCallback");
            return;
        }
        beginConnect(call);
    }

    private void beginConnect(PluginCall call) {
        String address = call.getString("deviceAddress");
        if (manager == null || channel == null || address == null || address.isEmpty()) {
            call.reject("A discovered Wi-Fi Direct device is required.");
            return;
        }
        if (!p2pEnabled) {
            call.reject("Wi-Fi Direct is disabled. Turn on Wi-Fi and try again.");
            return;
        }
        if (pendingConnectCall != null) {
            call.reject("A Wi-Fi Direct connection attempt is already in progress.");
            return;
        }

        localDisplayName = cleanName(call.getString("displayName"));
        localPeerId = safeValue(call.getString("peerId"), localPeerId);
        localFingerprint = safeValue(call.getString("fingerprint"), localFingerprint);
        pendingConnectCall = call;
        mainHandler.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);

        WifiP2pConfig config = new WifiP2pConfig();
        config.deviceAddress = address;
        config.groupOwnerIntent = 7;
        try {
            manager.connect(channel, config, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {
                    notifyListeners("onConnectionState", event("state", "negotiating"));
                }

                @Override
                public void onFailure(int reason) {
                    rejectConnect("Wi-Fi Direct connection failed (" + reason + ").");
                }
            });
        } catch (SecurityException error) {
            rejectConnect("Nearby Wi-Fi permission is missing.", error);
        }
    }

    private final Runnable connectTimeout = () -> rejectConnect(
        "Wi-Fi Direct timed out before a local socket connection was established."
    );

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        if (manager == null || channel == null) {
            call.resolve();
            return;
        }
        try {
            manager.stopPeerDiscovery(channel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { clearLocalService(call); }
                @Override public void onFailure(int reason) { clearLocalService(call); }
            });
        } catch (SecurityException error) {
            discovering = false;
            call.reject("Unable to stop Wi-Fi Direct discovery.", error);
        }
    }

    private void clearLocalService(PluginCall call) {
        if (serviceRequestRegistered && serviceRequest != null) {
            manager.removeServiceRequest(channel, serviceRequest, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { removeLocalService(call); }
                @Override public void onFailure(int reason) { removeLocalService(call); }
            });
            return;
        }
        removeLocalService(call);
    }

    private void removeLocalService(PluginCall call) {
        serviceRequestRegistered = false;
        serviceRequest = null;
        if (localServiceRegistered && localService != null) {
            manager.removeLocalService(channel, localService, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { finishStopDiscovery(call); }
                @Override public void onFailure(int reason) { finishStopDiscovery(call); }
            });
            return;
        }
        finishStopDiscovery(call);
    }

    private void finishStopDiscovery(PluginCall call) {
        localServiceRegistered = false;
        localService = null;
        registeredDisplayName = null;
        meshChatNames.clear();
        discovering = false;
        emitStatus();
        call.resolve();
    }

    @PluginMethod
    public void sendPacket(PluginCall call) {
        String peerId = call.getString("deviceId");
        String encoded = call.getString("dataBase64");
        PeerSocket peer = peerId == null ? null : sockets.get(peerId);
        if (peer == null || peer.closed) {
            call.reject("No active Wi-Fi Direct socket for this peer.");
            return;
        }
        if (encoded == null || encoded.isEmpty() || encoded.length() > 44_000) {
            call.reject("Invalid or oversized Wi-Fi Direct packet.");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid Base64 Wi-Fi Direct packet.", error);
            return;
        }
        if (bytes.length == 0 || bytes.length > MAX_PACKET_BYTES) {
            call.reject("Wi-Fi Direct packet exceeds the size limit.");
            return;
        }

        ioExecutor.execute(() -> {
            try {
                writeFrame(peer, bytes);
                call.resolve();
            } catch (IOException error) {
                closePeer(peer, true);
                call.reject("Wi-Fi Direct send failed: " + error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String peerId = call.getString("deviceId");
        PeerSocket peer = peerId == null ? null : sockets.get(peerId);
        if (peer != null) closePeer(peer, true);
        call.resolve();
    }

    @PluginMethod
    public void removeGroup(PluginCall call) {
        groupFormed = false;
        closeAllSockets(true);
        if (manager == null || channel == null) {
            call.resolve();
            return;
        }
        try {
            manager.removeGroup(channel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { call.resolve(); }
                @Override public void onFailure(int reason) { call.resolve(); }
            });
        } catch (SecurityException error) {
            call.reject("Unable to close the Wi-Fi Direct group.", error);
        }
    }

    private void emitDiscovered(String address, String name, int status) {
        if (address == null || address.isEmpty()) return;
        JSObject peer = new JSObject();
        peer.put("deviceAddress", address);
        peer.put("deviceName", cleanName(name));
        peer.put("status", status);
        notifyListeners("onPeerDiscovered", peer);
    }

    private void requestPeers() {
        if (manager == null || channel == null || !hasRequiredPermission()) return;
        try {
            manager.requestPeers(channel, new WifiP2pManager.PeerListListener() {
                @Override
                public void onPeersAvailable(WifiP2pDeviceList list) {
                    for (WifiP2pDevice device : list.getDeviceList()) {
                        if (device.deviceAddress == null || device.deviceAddress.isEmpty()) continue;
                        String selectedName = meshChatNames.get(device.deviceAddress);
                        if (selectedName != null) emitDiscovered(device.deviceAddress, selectedName, device.status);
                    }
                }
            });
        } catch (SecurityException error) {
            emitError("permission", "Nearby Wi-Fi permission is required to read peers.");
        }
    }

    private void requestConnectionInfo() {
        if (manager == null || channel == null || !hasRequiredPermission()) return;
        try {
            manager.requestConnectionInfo(channel, info -> {
                if (info == null || !info.groupFormed) {
                    if (groupFormed) {
                        groupFormed = false;
                        closeAllSockets(true);
                        rejectConnect("Wi-Fi Direct group disconnected.");
                    }
                    emitStatus();
                    return;
                }
                groupFormed = true;
                emitStatus();
                if (info.isGroupOwner) {
                    startSocketServer();
                } else if (info.groupOwnerAddress != null) {
                    connectToGroupOwner(info.groupOwnerAddress.getHostAddress());
                }
            });
        } catch (SecurityException error) {
            emitError("permission", "Nearby Wi-Fi permission is required to inspect the group.");
        }
    }

    private synchronized void startSocketServer() {
        if (socketServerStarting || (serverSocket != null && !serverSocket.isClosed())) return;
        socketServerStarting = true;
        ioExecutor.execute(() -> {
            try {
                ServerSocket server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(SOCKET_PORT), 8);
                serverSocket = server;
                socketServerStarting = false;
                while (!server.isClosed()) {
                    Socket socket = server.accept();
                    socket.setTcpNoDelay(true);
                    ioExecutor.execute(() -> handleSocket(socket));
                }
            } catch (IOException error) {
                socketServerStarting = false;
                if (serverSocket == null || !serverSocket.isClosed()) {
                    emitError("socket-server", "Unable to accept Wi-Fi Direct connections: " + error.getMessage());
                }
            }
        });
    }

    private void connectToGroupOwner(String host) {
        if (clientConnecting) return;
        clientConnecting = true;
        ioExecutor.execute(() -> {
            IOException lastError = null;
            for (int attempt = 0; attempt < 10 && !Thread.currentThread().isInterrupted(); attempt++) {
                Socket socket = new Socket();
                try {
                    socket.connect(new InetSocketAddress(host, SOCKET_PORT), 2500);
                    socket.setTcpNoDelay(true);
                    handleSocket(socket);
                    clientConnecting = false;
                    return;
                } catch (IOException error) {
                    lastError = error;
                    try { socket.close(); } catch (IOException ignored) {}
                    try { Thread.sleep(450); } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            clientConnecting = false;
            String message = lastError == null ? "Could not reach the Wi-Fi Direct group owner." : lastError.getMessage();
            mainHandler.post(() -> rejectConnect("Wi-Fi Direct socket connection failed: " + message));
        });
    }

    private void handleSocket(Socket socket) {
        PeerSocket peer;
        try {
            peer = new PeerSocket(socket);
            writeFrame(peer, makeHello().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException error) {
            closeSocket(socket);
            emitError("socket", "Could not initialize the local Wi-Fi Direct socket.");
            return;
        }

        ioExecutor.execute(() -> readLoop(peer));
    }

    private JSONObject makeHello() throws IOException {
        JSONObject hello = new JSONObject();
        try {
            hello.put("type", "meshchat-hello");
            hello.put("version", 1);
            hello.put("peerId", bounded(localPeerId, 128));
            hello.put("displayName", cleanName(localDisplayName));
            hello.put("fingerprint", bounded(localFingerprint, 128));
        } catch (JSONException error) {
            throw new IOException("Unable to encode Wi-Fi Direct hello.", error);
        }
        return hello;
    }

    private void readLoop(PeerSocket peer) {
        try {
            while (!peer.closed) {
                int length = peer.input.readInt();
                if (length < 1 || length > MAX_PACKET_BYTES) {
                    throw new IOException("Invalid Wi-Fi Direct frame length.");
                }
                byte[] bytes = new byte[length];
                peer.input.readFully(bytes);
                if (peer.peerId == null) {
                    acceptHello(peer, bytes);
                    continue;
                }
                JSObject event = new JSObject();
                event.put("deviceId", peer.peerId);
                event.put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                notifyListeners("onPacketReceived", event);
            }
        } catch (EOFException ignored) {
            closePeer(peer, true);
        } catch (IOException error) {
            if (!peer.closed) {
                emitError("socket-read", "Wi-Fi Direct connection ended: " + error.getMessage());
                closePeer(peer, true);
            }
        }
    }

    private void acceptHello(PeerSocket peer, byte[] bytes) throws IOException {
        if (bytes.length > 1024) throw new IOException("Oversized Wi-Fi Direct hello.");
        try {
            JSONObject hello = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            String id = hello.optString("peerId", "");
            if (!"meshchat-hello".equals(hello.optString("type"))
                || hello.optInt("version", -1) != 1
                || id.length() < 8 || id.length() > 128) {
                throw new IOException("Peer does not speak the MeshChat Wi-Fi protocol.");
            }
            peer.peerId = id;
            peer.displayName = cleanName(hello.optString("displayName", "Nearby MeshChat device"));
            peer.fingerprint = bounded(hello.optString("fingerprint", ""), 128);
            PeerSocket previous = sockets.put(id, peer);
            if (previous != null && previous != peer) closeSocket(previous.socket);

            JSObject event = new JSObject();
            event.put("deviceId", id);
            event.put("deviceName", peer.displayName);
            event.put("fingerprint", peer.fingerprint);
            event.put("initiated", pendingConnectCall != null);
            notifyListeners("onPeerConnected", event);
            emitStatus();
            if (pendingConnectCall != null) {
                PluginCall call = pendingConnectCall;
                pendingConnectCall = null;
                mainHandler.removeCallbacks(connectTimeout);
                JSObject result = new JSObject();
                result.put("deviceId", id);
                result.put("deviceName", peer.displayName);
                result.put("fingerprint", peer.fingerprint);
                call.resolve(result);
            }
        } catch (JSONException error) {
            throw new IOException("Invalid MeshChat Wi-Fi handshake.", error);
        }
    }

    private JSObject event(String key, Object value) {
        JSObject result = new JSObject();
        result.put(key, value);
        return result;
    }

    private void emitStatus() {
        JSObject status = new JSObject();
        status.put("enabled", p2pEnabled);
        status.put("discovering", discovering);
        status.put("groupFormed", groupFormed);
        status.put("connectedPeers", sockets.size());
        notifyListeners("onStatus", status);
    }

    private void emitError(String kind, String message) {
        JSObject error = new JSObject();
        error.put("kind", kind);
        error.put("message", message);
        notifyListeners("onError", error);
    }

    private static void writeFrame(PeerSocket peer, byte[] bytes) throws IOException {
        if (bytes == null || bytes.length < 1 || bytes.length > MAX_PACKET_BYTES) {
            throw new IOException("Packet size is outside the allowed range.");
        }
        synchronized (peer.output) {
            if (peer.closed || peer.socket.isClosed()) throw new IOException("Socket is closed.");
            peer.output.writeInt(bytes.length);
            peer.output.write(bytes);
            peer.output.flush();
        }
    }

    private void closePeer(PeerSocket peer, boolean notify) {
        if (peer == null || peer.closed) return;
        peer.closed = true;
        if (peer.peerId != null) sockets.remove(peer.peerId, peer);
        closeSocket(peer.socket);
        if (notify && peer.peerId != null) {
            JSObject event = new JSObject();
            event.put("deviceId", peer.peerId);
            notifyListeners("onPeerDisconnected", event);
        }
        emitStatus();
    }

    private void closeAllSockets(boolean notify) {
        for (PeerSocket peer : new ArrayList<>(sockets.values())) closePeer(peer, notify);
        ServerSocket server = serverSocket;
        serverSocket = null;
        if (server != null) {
            try { server.close(); } catch (IOException ignored) {}
        }
        socketServerStarting = false;
        clientConnecting = false;
    }

    private void rejectConnect(String message) {
        rejectConnect(message, null);
    }

    private void rejectConnect(String message, Exception error) {
        mainHandler.removeCallbacks(connectTimeout);
        PluginCall call = pendingConnectCall;
        pendingConnectCall = null;
        if (call != null) {
            if (error == null) call.reject(message);
            else call.reject(message, error);
        }
    }

    private static void closeSocket(Socket socket) {
        try { socket.close(); } catch (IOException ignored) {}
    }

    private static String cleanName(String value) {
        String name = value == null ? "" : value.replaceAll("[\\p{Cntrl}]", "").trim();
        if (name.isEmpty()) return "MeshChat device";
        return name.length() > 32 ? name.substring(0, 32) : name;
    }

    private static String safeValue(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static String bounded(String value, int maximum) {
        if (value == null) return "";
        return value.length() > maximum ? value.substring(0, maximum) : value;
    }

    @Override
    protected void handleOnDestroy() {
        mainHandler.removeCallbacks(connectTimeout);
        rejectConnect("Wi-Fi Direct plugin was stopped.");
        groupFormed = false;
        closeAllSockets(false);
        if (manager != null && channel != null) {
            try { manager.stopPeerDiscovery(channel, null); } catch (Exception ignored) {}
            try {
                if (serviceRequest != null) manager.removeServiceRequest(channel, serviceRequest, null);
                if (localService != null) manager.removeLocalService(channel, localService, null);
                manager.removeGroup(channel, null);
            } catch (Exception ignored) {}
        }
        if (receiverRegistered && receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiverRegistered = false;
        }
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
