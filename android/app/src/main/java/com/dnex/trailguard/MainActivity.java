package com.dnex.trailguard;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HardwareKeyPlugin.class);
        registerPlugin(CriticalAlertPlugin.class);
        showOverLockScreen(fromCriticalAlert(getIntent()));
        super.onCreate(savedInstanceState);
    }

    /** Critical-alert notification tapped (or full-screen intent fired) while the app was already running. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        showOverLockScreen(fromCriticalAlert(intent));
        CriticalAlertPlugin.deliverIntent(intent);
    }

    /** Only a critical alert may show the app over the lock screen; leaving the app turns it off again. */
    @Override
    protected void onStop() {
        showOverLockScreen(false);
        super.onStop();
    }

    private static boolean fromCriticalAlert(Intent intent) {
        return intent != null && intent.hasExtra(CriticalAlertPlugin.EXTRA_INCIDENT);
    }

    private void showOverLockScreen(boolean show) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(show);
            setTurnScreenOn(show);
        }
    }

    /**
     * Hardware buttons bound to push-to-talk or SOS (XCover 1015, STEM_PRIMARY 264,
     * STEM_1 265, Top 1079, or keys the user added) go to the web app instead of the
     * WebView, which would otherwise report them as "Unidentified" or ignore them.
     * While the user is binding a new button, the next key down is captured.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0
                && HardwareKeyPlugin.isLearning() && HardwareKeyPlugin.offerLearn(code)) {
            return true;
        }
        if (HardwareKeyPlugin.isCaptured(code)) {
            if (event.getRepeatCount() == 0 || event.getAction() == KeyEvent.ACTION_UP) {
                HardwareKeyPlugin.emit(code, event.getAction() == KeyEvent.ACTION_DOWN, "activity");
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
