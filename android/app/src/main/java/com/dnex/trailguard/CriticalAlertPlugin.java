package com.dnex.trailguard;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Critical (red) alerts that get through silent mode and Do Not Disturb.
 *
 * Two parts, both needed:
 *  1. Notification on a dedicated channel: importance HIGH, alarm sound
 *     (AudioAttributes.USAGE_ALARM), category ALARM, lock-screen visible, and a
 *     full-screen intent that lights the screen and opens the alert. When the user
 *     has granted "Do Not Disturb access" to Trailguard, the channel is created
 *     with setBypassDnd(true). Android only honours that flag when the channel is
 *     created, so the channel is re-created under a new id once access is granted.
 *  2. A looping alarm sound played through the ALARM stream with MediaPlayer.
 *     The alarm stream is not muted by the ringer switch (silent / vibrate) and is
 *     allowed in the default DND "Alarms" exception. Optionally the alarm volume is
 *     raised to at least 80 % for the duration of the alarm and restored after.
 *
 * Tapping the notification opens the app and emits "tap" { incidentId } to JS.
 */
@CapacitorPlugin(name = "CriticalAlert")
public class CriticalAlertPlugin extends Plugin {

    static final String CHANNEL_STANDARD = "tg_critical_std";
    static final String CHANNEL_BYPASS_DND = "tg_critical_dnd";
    static final String EXTRA_INCIDENT = "com.dnex.trailguard.extra.INCIDENT_ID";
    static final String EXTRA_ALERT_KEY = "com.dnex.trailguard.extra.ALERT_KEY";
    private static final long[] VIBRATION = new long[] { 0, 700, 300, 700, 300, 1200 };

    private static CriticalAlertPlugin instance;

    private MediaPlayer player;
    private int restoreVolume = -1;

    @Override
    public void load() {
        instance = this;
        ensureChannel();
        if (getActivity() != null) handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnDestroy() {
        stopAlarmInternal();
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** Called by MainActivity for new intents (notification taps while running). */
    static void deliverIntent(Intent intent) {
        CriticalAlertPlugin plugin = instance;
        if (plugin != null) plugin.handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null || !intent.hasExtra(EXTRA_INCIDENT)) return;
        JSObject data = new JSObject();
        data.put("incidentId", intent.getStringExtra(EXTRA_INCIDENT));
        data.put("key", intent.getStringExtra(EXTRA_ALERT_KEY));
        intent.removeExtra(EXTRA_INCIDENT);
        notifyListeners("tap", data, true);
    }

    private NotificationManager systemManager() {
        return (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private boolean policyAccess() {
        NotificationManager nm = systemManager();
        return nm != null && Build.VERSION.SDK_INT >= 23 && nm.isNotificationPolicyAccessGranted();
    }

    private Uri alarmSound() {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return uri;
    }

    private AudioAttributes alarmAttributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    /** The channel id in use: the DND-bypassing one once access has been granted. */
    private String ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return CHANNEL_STANDARD;
        NotificationManager nm = systemManager();
        if (nm == null) return CHANNEL_STANDARD;
        boolean bypass = policyAccess();
        String id = bypass ? CHANNEL_BYPASS_DND : CHANNEL_STANDARD;
        String other = bypass ? CHANNEL_STANDARD : CHANNEL_BYPASS_DND;
        if (nm.getNotificationChannel(other) != null) nm.deleteNotificationChannel(other);
        if (nm.getNotificationChannel(id) == null) {
            NotificationChannel channel = new NotificationChannel(id, "Critical emergency alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("SOS, critical (P1) cases, fire alerts and critical announcements. Sounds even in silent mode.");
            channel.setSound(alarmSound(), alarmAttributes());
            channel.enableVibration(true);
            channel.setVibrationPattern(VIBRATION);
            channel.enableLights(true);
            channel.setLightColor(0xFFFF0000);
            channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
            channel.setBypassDnd(bypass);
            nm.createNotificationChannel(channel);
        }
        return id;
    }

    private boolean canUseFullScreen() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = systemManager();
        return nm != null && nm.canUseFullScreenIntent();
    }

    @PluginMethod
    public void status(PluginCall call) {
        String id = ensureChannel();
        JSObject result = new JSObject();
        result.put("notificationsEnabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        result.put("dndAccess", policyAccess());
        result.put("fullScreen", canUseFullScreen());
        result.put("channel", id);
        boolean bypassing = false;
        if (Build.VERSION.SDK_INT >= 26 && systemManager() != null && systemManager().getNotificationChannel(id) != null) {
            bypassing = systemManager().getNotificationChannel(id).canBypassDnd();
        }
        result.put("channelBypassesDnd", bypassing);
        call.resolve(result);
    }

    /** Opens Settings > Do Not Disturb access, where the user allows Trailguard. */
    @PluginMethod
    public void openDndSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Do Not Disturb settings are not available on this device.");
        }
    }

    /** Android 14+: Settings > Special app access > Full-screen notifications. */
    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= 34) {
                intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Notification settings are not available on this device.");
        }
    }

    /** show({ id: number, key: string, title, body, incidentId?, fullScreen?: boolean }) */
    @PluginMethod
    public void show(PluginCall call) {
        Integer id = call.getInt("id");
        String title = call.getString("title", "Trailguard alert");
        String body = call.getString("body", "");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        String channel = ensureChannel();
        Context ctx = getContext();
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        String incidentId = call.getString("incidentId");
        open.putExtra(EXTRA_INCIDENT, incidentId == null ? "" : incidentId);
        open.putExtra(EXTRA_ALERT_KEY, call.getString("key", ""));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent content = PendingIntent.getActivity(ctx, id, open, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(ctx.getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setColor(0xFFE5262B)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setContentIntent(content)
            .setSound(alarmSound(), AudioManager.STREAM_ALARM)
            .setVibrate(VIBRATION);
        if (call.getBoolean("fullScreen", true) && canUseFullScreen()) builder.setFullScreenIntent(content, true);
        try {
            NotificationManagerCompat.from(ctx).notify(id, builder.build());
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Notification permission is off.");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id");
        if (id != null) NotificationManagerCompat.from(getContext()).cancel(id);
        call.resolve();
    }

    /** startAlarm({ forceVolume?: boolean }) — loops the alarm sound until stopAlarm(). */
    @PluginMethod
    public void startAlarm(PluginCall call) {
        boolean force = call.getBoolean("forceVolume", true);
        getBridge().executeOnMainThread(() -> {
            try {
                startAlarmInternal(force);
                call.resolve();
            } catch (Exception e) {
                call.reject("Alarm sound unavailable: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopAlarm(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            stopAlarmInternal();
            call.resolve();
        });
    }

    private void startAlarmInternal(boolean forceVolume) throws Exception {
        if (player != null) return;
        Context ctx = getContext();
        AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (forceVolume && audio != null) {
            int max = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM);
            int current = audio.getStreamVolume(AudioManager.STREAM_ALARM);
            int wanted = (int) Math.ceil(max * 0.8);
            if (current < wanted) {
                restoreVolume = current;
                try {
                    audio.setStreamVolume(AudioManager.STREAM_ALARM, wanted, 0);
                } catch (SecurityException e) {
                    restoreVolume = -1; // DND policy forbids volume changes: play at the current level
                }
            }
        }
        MediaPlayer mp = new MediaPlayer();
        mp.setAudioAttributes(alarmAttributes());
        mp.setDataSource(ctx, alarmSound());
        mp.setLooping(true);
        mp.prepare();
        mp.start();
        player = mp;

        Vibrator vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null && vibrator.hasVibrator()) {
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION, 1), alarmAttributes());
            else vibrator.vibrate(VIBRATION, 1);
        }
    }

    private void stopAlarmInternal() {
        if (player != null) {
            try {
                player.stop();
            } catch (IllegalStateException ignored) {
                // never started
            }
            player.release();
            player = null;
        }
        Context ctx = getContext();
        if (ctx == null) return;
        Vibrator vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null) vibrator.cancel();
        if (restoreVolume >= 0) {
            AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) {
                try {
                    audio.setStreamVolume(AudioManager.STREAM_ALARM, restoreVolume, 0);
                } catch (SecurityException ignored) {
                    // leave as is
                }
            }
            restoreVolume = -1;
        }
    }
}
