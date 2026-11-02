package com.dnex.trailguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receives Samsung's hardware-key broadcast for the XCover and Top keys
 * ("unmanaged key mapping": the user picks this app in Settings > Advanced
 * features > XCover key > Control XCover key with app).
 *
 * Extras: KEY_CODE (1015 XCover, 1079 Top) and KEY_REPORT_TYPE (1 = down, 2 = up).
 * If the app is not running, a press opens it so the user can talk.
 */
public class HardKeyReceiver extends BroadcastReceiver {

    public static final String ACTION_HARD_KEY_REPORT = "com.samsung.android.knox.intent.action.HARD_KEY_REPORT";
    public static final String EXTRA_KEY_CODE = "com.samsung.android.knox.intent.extra.KEY_CODE";
    public static final String EXTRA_REPORT_TYPE = "com.samsung.android.knox.intent.extra.KEY_REPORT_TYPE";
    public static final int REPORT_DOWN = 1;
    public static final int REPORT_UP = 2;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_HARD_KEY_REPORT.equals(intent.getAction())) return;
        int keyCode = intent.getIntExtra(EXTRA_KEY_CODE, -1);
        int type = intent.getIntExtra(EXTRA_REPORT_TYPE, -1);
        if (keyCode < 0 || (type != REPORT_DOWN && type != REPORT_UP)) return;

        if (HardwareKeyPlugin.isActive()) {
            HardwareKeyPlugin.emit(keyCode, type == REPORT_DOWN, "broadcast");
        } else if (type == REPORT_DOWN) {
            // App not running: bring it up. (Android may block this from the
            // background on some versions; the user can then open it manually.)
            Intent launch = new Intent(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            try {
                context.startActivity(launch);
            } catch (RuntimeException ignored) {
                // Background activity start not allowed: nothing else to do.
            }
        }
    }
}
