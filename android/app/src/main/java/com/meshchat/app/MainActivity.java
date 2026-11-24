package com.meshchat.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.meshchat.ble.MeshBlePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MeshBlePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
