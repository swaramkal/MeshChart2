package com.meshchat.audio;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Live voice capture and playback: 16 kHz, mono, signed 16-bit PCM in 20 ms
 * frames (640 bytes). Frames are handed to JavaScript, which encrypts and sends
 * them through the existing secure channel over Wi-Fi Direct. This plugin does
 * no networking of its own.
 */
@CapacitorPlugin(
    name = "MeshAudio",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class MeshAudioPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16_000;
    private static final int FRAME_BYTES = 640;          // 20 ms
    private static final int MAX_PLAY_FRAMES = 10;       // cap playback delay at ~200 ms

    private final Object lock = new Object();
    private AudioRecord recorder;
    private AudioTrack track;
    private AcousticEchoCanceler echoCanceler;
    private NoiseSuppressor noiseSuppressor;
    private Thread captureThread;
    private Thread playThread;
    private volatile boolean running;
    private volatile boolean muted;
    private ArrayBlockingQueue<byte[]> playQueue;
    private int previousMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeaker;

    @PluginMethod
    public void requestMicrophone(PluginCall call) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            resolveGranted(call, true);
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            // The ongoing-call notification needs this on Android 13+; the call
            // still works if it is denied, so only the microphone is required.
            requestPermissionForAliases(new String[] { "microphone", "notifications" }, call, "microphonePermissionCallback");
        } else {
            requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
        }
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        resolveGranted(call, getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED);
    }

    private void resolveGranted(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Microphone permission is required for voice calls.");
            return;
        }
        synchronized (lock) {
            if (running) {
                call.resolve();
                return;
            }
            try {
                try {
                    MeshCallService.start(getContext());
                } catch (RuntimeException ignored) {
                    // Foreground start can be refused by the OS; the call still works in the foreground.
                }
                openAudio();
            } catch (Exception error) {
                closeAudio();
                call.reject("Unable to start audio: " + error.getMessage());
                return;
            }
            running = true;
            captureThread = new Thread(this::captureLoop, "meshchat-audio-capture");
            playThread = new Thread(this::playLoop, "meshchat-audio-play");
            captureThread.start();
            playThread.start();
        }
        call.resolve();
    }

    private void openAudio() {
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        previousMode = audioManager.getMode();
        previousSpeaker = audioManager.isSpeakerphoneOn();
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        audioManager.setSpeakerphoneOn(false);

        int minRecord = AudioRecord.getMinBufferSize(SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int minTrack = AudioTrack.getMinBufferSize(SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minRecord <= 0 || minTrack <= 0) throw new IllegalStateException("16 kHz mono audio is not supported.");

        recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            Math.max(minRecord, FRAME_BYTES * 4));
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            throw new IllegalStateException("Microphone could not be opened.");
        }
        if (AcousticEchoCanceler.isAvailable()) {
            echoCanceler = AcousticEchoCanceler.create(recorder.getAudioSessionId());
            if (echoCanceler != null) echoCanceler.setEnabled(true);
        }
        if (NoiseSuppressor.isAvailable()) {
            noiseSuppressor = NoiseSuppressor.create(recorder.getAudioSessionId());
            if (noiseSuppressor != null) noiseSuppressor.setEnabled(true);
        }

        track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            .setAudioFormat(new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build())
            .setBufferSizeInBytes(Math.max(minTrack, FRAME_BYTES * 4))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
        if (track.getState() != AudioTrack.STATE_INITIALIZED) {
            throw new IllegalStateException("Audio output could not be opened.");
        }

        playQueue = new ArrayBlockingQueue<>(MAX_PLAY_FRAMES);
        recorder.startRecording();
        track.play();
    }

    private void captureLoop() {
        byte[] buffer = new byte[FRAME_BYTES];
        try {
            while (running) {
                int offset = 0;
                while (running && offset < FRAME_BYTES) {
                    int read = recorder.read(buffer, offset, FRAME_BYTES - offset);
                    if (read < 0) throw new IllegalStateException("Microphone read failed (" + read + ").");
                    offset += read;
                }
                if (!running || muted) continue;
                JSObject event = new JSObject();
                event.put("pcm", Base64.encodeToString(buffer, 0, FRAME_BYTES, Base64.NO_WRAP));
                notifyListeners("onAudioFrame", event);
            }
        } catch (Exception error) {
            if (running) reportError(error.getMessage());
        }
    }

    private void playLoop() {
        try {
            while (running) {
                byte[] frame = playQueue.poll(100, TimeUnit.MILLISECONDS);
                if (frame != null && track != null) track.write(frame, 0, frame.length);
            }
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            if (running) reportError(error.getMessage());
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        String pcm = call.getString("pcm");
        if (!running || pcm == null) {
            call.resolve();
            return;
        }
        try {
            byte[] frame = Base64.decode(pcm, Base64.DEFAULT);
            if (frame.length == FRAME_BYTES) {
                // Keep latency bounded: drop the oldest frame when the queue is full.
                while (!playQueue.offer(frame)) playQueue.poll();
            }
        } catch (IllegalArgumentException ignored) {
            // Malformed frame: drop it.
        }
        call.resolve();
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
        call.resolve();
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        audioManager.setSpeakerphoneOn(Boolean.TRUE.equals(call.getBoolean("speaker", false)));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        synchronized (lock) {
            closeAudio();
        }
        call.resolve();
    }

    private void closeAudio() {
        running = false;
        Thread capture = captureThread;
        Thread play = playThread;
        captureThread = null;
        playThread = null;
        if (play != null) play.interrupt();
        try { if (capture != null) capture.join(300); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        try { if (play != null) play.join(300); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        if (echoCanceler != null) { echoCanceler.release(); echoCanceler = null; }
        if (noiseSuppressor != null) { noiseSuppressor.release(); noiseSuppressor = null; }
        if (recorder != null) {
            try { recorder.stop(); } catch (IllegalStateException ignored) { }
            recorder.release();
            recorder = null;
        }
        if (track != null) {
            try { track.stop(); } catch (IllegalStateException ignored) { }
            track.release();
            track = null;
        }
        muted = false;
        if (getContext() != null) {
            MeshCallService.stop(getContext());
            AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                audioManager.setMode(previousMode);
                audioManager.setSpeakerphoneOn(previousSpeaker);
            }
        }
    }

    private void reportError(String message) {
        JSObject event = new JSObject();
        event.put("message", message == null ? "Audio error" : message);
        notifyListeners("onAudioError", event);
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            closeAudio();
        }
        super.handleOnDestroy();
    }
}
