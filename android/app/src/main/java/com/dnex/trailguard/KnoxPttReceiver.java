package com.dnex.trailguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Push-to-talk intents from a managed Samsung device (Knox Service Plugin /
 * Knox Manage "hardware key remapping": the XCover or Top key is mapped to
 * "send broadcast intent" with an action of the administrator's choosing).
 *
 * Trailguard listens for these actions by default:
 *   com.samsung.android.knox.intent.action.PTT_PRESS    — key down (start talking)
 *   com.samsung.android.knox.intent.action.PTT_RELEASE  — key up (stop talking)
 * A single action carrying KEY_REPORT_TYPE (1 = down, 2 = up) also works. Other
 * action names can be set in the app (device settings), which registers them at
 * runtime in HardwareKeyPlugin; this manifest receiver also wakes the app for the
 * defaults when the KSP intent is sent to the package explicitly.
 *
 * Any app on the phone could send these broadcasts, so the web app only acts on
 * them while the user has "Knox PTT intents" enabled, caps each transmission at
 * 60 s like every other PTT source, and shows the on-air indicator.
 */
public class KnoxPttReceiver extends BroadcastReceiver {

    public static final String ACTION_PTT_PRESS = "com.samsung.android.knox.intent.action.PTT_PRESS";
    public static final String ACTION_PTT_RELEASE = "com.samsung.android.knox.intent.action.PTT_RELEASE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (!ACTION_PTT_PRESS.equals(action) && !ACTION_PTT_RELEASE.equals(action)) return;
        HardwareKeyPlugin.handlePttIntent(context, intent, ACTION_PTT_PRESS, ACTION_PTT_RELEASE);
    }
}
