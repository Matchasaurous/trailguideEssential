package com.dnex.trailguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.core.content.ContextCompat;

import java.util.HashSet;
import java.util.Set;

/**
 * Forwards hardware push-to-talk and SOS buttons to the web app as "hardwareKey"
 * events: { keyCode: number, down: boolean, source: "activity" | "broadcast" }.
 *
 * Sources:
 *  - MainActivity.dispatchKeyEvent: key events while the app is in the foreground.
 *    Which key codes are captured is set from JS with setKeys(); defaults are the
 *    Samsung XCover key (1015), KEYCODE_STEM_PRIMARY (264) and KEYCODE_STEM_1 (265)
 *    for talk, and the Samsung Top key (1079) for SOS.
 *  - HardKeyReceiver: Samsung's HARD_KEY_REPORT broadcast for the XCover / Top keys
 *    (Settings > Advanced features > XCover key > Control XCover key with app).
 *  - Knox PTT intents (KnoxPttReceiver and a runtime receiver registered here):
 *    managed devices whose XCover key is remapped to a broadcast such as
 *    com.samsung.android.knox.intent.action.PTT_PRESS / PTT_RELEASE. These are
 *    emitted with source "intent" and ptt: true.
 *
 * learn() captures the next button pressed (except Back, which cancels) so users
 * can bind other rugged-device or accessory buttons.
 */
@CapacitorPlugin(name = "HardwareKey")
public class HardwareKeyPlugin extends Plugin {

    public static final int KEYCODE_XCOVER = 1015;
    public static final int KEYCODE_TOP = 1079;
    public static final int KEYCODE_STEM_PRIMARY = 264;
    public static final int KEYCODE_STEM_1 = 265;

    private static HardwareKeyPlugin instance;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Set<Integer> captured = new HashSet<>();
    private static PluginCall learnCall;
    private static String pttPressAction = KnoxPttReceiver.ACTION_PTT_PRESS;
    private static String pttReleaseAction = KnoxPttReceiver.ACTION_PTT_RELEASE;
    private BroadcastReceiver runtimeReceiver;

    static {
        captured.add(KEYCODE_XCOVER);
        captured.add(KEYCODE_STEM_PRIMARY);
        captured.add(KEYCODE_STEM_1);
        captured.add(KEYCODE_TOP);
    }

    @Override
    public void load() {
        instance = this;
        registerRuntimeReceiver();
    }

    @Override
    protected void handleOnDestroy() {
        unregisterRuntimeReceiver();
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** Listen for the configured Knox PTT actions while the app runs (custom names need this). */
    private void registerRuntimeReceiver() {
        unregisterRuntimeReceiver();
        final String press;
        final String release;
        synchronized (HardwareKeyPlugin.class) {
            press = pttPressAction;
            release = pttReleaseAction;
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(press);
        if (release != null && !release.isEmpty() && !release.equals(press)) filter.addAction(release);
        runtimeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                // The manifest receiver already handles the default actions.
                if (intent == null || KnoxPttReceiver.ACTION_PTT_PRESS.equals(intent.getAction())
                        || KnoxPttReceiver.ACTION_PTT_RELEASE.equals(intent.getAction())) return;
                handlePttIntent(context, intent, press, release);
            }
        };
        ContextCompat.registerReceiver(getContext(), runtimeReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }

    private void unregisterRuntimeReceiver() {
        if (runtimeReceiver == null) return;
        try {
            getContext().unregisterReceiver(runtimeReceiver);
        } catch (IllegalArgumentException ignored) {
            // not registered
        }
        runtimeReceiver = null;
    }

    /**
     * A Knox PTT intent: press action = key down, release action = key up. When
     * one action is used for both, KEY_REPORT_TYPE (1 down / 2 up) decides.
     */
    static void handlePttIntent(Context context, Intent intent, String press, String release) {
        String action = intent.getAction();
        int type = intent.getIntExtra(HardKeyReceiver.EXTRA_REPORT_TYPE, -1);
        boolean down;
        if (type == HardKeyReceiver.REPORT_DOWN || type == HardKeyReceiver.REPORT_UP) {
            down = type == HardKeyReceiver.REPORT_DOWN;
        } else if (action != null && action.equals(release) && !action.equals(press)) {
            down = false;
        } else if (action != null && action.equals(press)) {
            down = true;
        } else {
            return;
        }
        int keyCode = intent.getIntExtra(HardKeyReceiver.EXTRA_KEY_CODE, KEYCODE_XCOVER);
        if (isActive()) {
            emitPtt(keyCode, down, action);
        } else if (down) {
            Intent launch = new Intent(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            try {
                context.startActivity(launch);
            } catch (RuntimeException ignored) {
                // Background activity start not allowed.
            }
        }
    }

    private static void emitPtt(final int keyCode, final boolean down, final String action) {
        final HardwareKeyPlugin plugin = instance;
        if (plugin == null) return;
        MAIN.post(() -> {
            JSObject data = new JSObject();
            data.put("keyCode", keyCode);
            data.put("down", down);
            data.put("source", "intent");
            data.put("ptt", true);
            data.put("action", action);
            plugin.notifyListeners("hardwareKey", data);
        });
    }

    /** setPttActions({ press: string, release: string }) — custom Knox broadcast action names. */
    @PluginMethod
    public void setPttActions(PluginCall call) {
        String press = call.getString("press", KnoxPttReceiver.ACTION_PTT_PRESS);
        String release = call.getString("release", KnoxPttReceiver.ACTION_PTT_RELEASE);
        if (press == null || !press.matches("^[A-Za-z0-9_.]{3,200}$") || (release != null && !release.isEmpty() && !release.matches("^[A-Za-z0-9_.]{3,200}$"))) {
            call.reject("Action names may only contain letters, digits, dots and underscores.");
            return;
        }
        synchronized (HardwareKeyPlugin.class) {
            pttPressAction = press;
            pttReleaseAction = release == null ? "" : release;
        }
        registerRuntimeReceiver();
        call.resolve();
    }

    /** True when a web page is loaded and listening (the app process is alive). */
    public static boolean isActive() {
        return instance != null;
    }

    public static synchronized boolean isCaptured(int keyCode) {
        return captured.contains(keyCode);
    }

    public static synchronized boolean isLearning() {
        return learnCall != null;
    }

    /**
     * Called by MainActivity for every key down while learning. Returns true when
     * the key was consumed by learn mode.
     */
    public static synchronized boolean offerLearn(int keyCode) {
        if (learnCall == null) return false;
        PluginCall call = learnCall;
        learnCall = null;
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            call.reject("cancelled");
        } else {
            JSObject result = new JSObject();
            result.put("keyCode", keyCode);
            call.resolve(result);
        }
        releaseKept(call);
        return true;
    }

    private static void releaseKept(PluginCall call) {
        HardwareKeyPlugin plugin = instance;
        if (plugin != null && plugin.getBridge() != null) call.release(plugin.getBridge());
    }

    /** Thread-safe: may be called from a BroadcastReceiver or the UI thread. */
    public static void emit(final int keyCode, final boolean down, final String source) {
        final HardwareKeyPlugin plugin = instance;
        if (plugin == null) return;
        MAIN.post(() -> {
            JSObject data = new JSObject();
            data.put("keyCode", keyCode);
            data.put("down", down);
            data.put("source", source);
            plugin.notifyListeners("hardwareKey", data);
        });
    }

    /** setKeys({ ptt: number[], sos: number[] }) — the key codes to capture. */
    @PluginMethod
    public void setKeys(PluginCall call) {
        Set<Integer> next = new HashSet<>();
        try {
            addAll(next, call.getArray("ptt"));
            addAll(next, call.getArray("sos"));
        } catch (Exception e) {
            call.reject("Key codes must be numbers");
            return;
        }
        synchronized (HardwareKeyPlugin.class) {
            captured.clear();
            captured.addAll(next);
        }
        call.resolve();
    }

    private static void addAll(Set<Integer> target, JSArray codes) throws Exception {
        if (codes == null) return;
        for (int i = 0; i < codes.length(); i++) {
            int code = codes.getInt(i);
            if (code > 0 && code != KeyEvent.KEYCODE_BACK && code != KeyEvent.KEYCODE_HOME) target.add(code);
        }
    }

    /** Resolves { keyCode } with the next hardware key pressed; Back cancels. */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void learn(PluginCall call) {
        synchronized (HardwareKeyPlugin.class) {
            if (learnCall != null) {
                learnCall.reject("cancelled");
                releaseKept(learnCall);
            }
            call.setKeepAlive(true);
            learnCall = call;
        }
    }

    @PluginMethod
    public void cancelLearn(PluginCall call) {
        synchronized (HardwareKeyPlugin.class) {
            if (learnCall != null) {
                learnCall.reject("cancelled");
                releaseKept(learnCall);
                learnCall = null;
            }
        }
        call.resolve();
    }

    /** Lets the web app check that the native key bridge is present. */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("xcoverKeyCode", KEYCODE_XCOVER);
        result.put("topKeyCode", KEYCODE_TOP);
        result.put("pttPressAction", pttPressAction);
        result.put("pttReleaseAction", pttReleaseAction);
        call.resolve(result);
    }
}
