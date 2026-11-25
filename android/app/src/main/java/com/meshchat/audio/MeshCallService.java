package com.meshchat.audio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps MeshChat alive during a voice call so audio
 * keeps flowing with the screen off or the app in the background. It holds a
 * partial wake lock and a Wi-Fi lock only while a call is running.
 */
public class MeshCallService extends Service {
    private static final String CHANNEL_ID = "meshchat_call";
    private static final int NOTIFICATION_ID = 4101;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context context) {
        Intent intent = new Intent(context, MeshCallService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, MeshCallService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = PendingIntent.getActivity(this, 0, launch,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("MeshChat voice call")
            .setContentText("Call in progress. Tap to return.")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW));
        }
    }

    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MeshChat:call");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(2 * 60 * 60 * 1000L); // safety cap: 2 hours
        }
        if (wifiLock == null) {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "MeshChat:call");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
