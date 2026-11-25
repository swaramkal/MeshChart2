package com.meshchat.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.meshchat.audio.MeshAudioPlugin;
import com.meshchat.ble.MeshBlePlugin;
import com.meshchat.wifi.MeshWifiDirectPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MeshBlePlugin.class);
        registerPlugin(MeshWifiDirectPlugin.class);
        registerPlugin(MeshAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
