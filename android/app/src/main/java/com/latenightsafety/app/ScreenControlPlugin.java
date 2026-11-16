package com.latenightsafety.app;

import android.app.Activity;
import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Lets the web app (js/screen-awake.js) keep the screen on while monitoring
 * and turn the brightness up while the white night light is shown.
 * Available in JavaScript as window.Capacitor.Plugins.ScreenControl.
 */
@CapacitorPlugin(name = "ScreenControl")
public class ScreenControlPlugin extends Plugin {

    /** Stops the screen from dimming, turning off or locking. */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    /** Lets the screen turn off normally again. */
    @PluginMethod
    public void allowSleep(PluginCall call) {
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    /**
     * Sets this app's screen brightness: value 0..1, or a negative value to go
     * back to the phone's own brightness setting.
     */
    @PluginMethod
    public void setBrightness(PluginCall call) {
        Double value = call.getDouble("value", -1.0);
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            WindowManager.LayoutParams params = window.getAttributes();
            if (value == null || value < 0) {
                params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            } else {
                params.screenBrightness = (float) Math.max(0.01, Math.min(1.0, value));
            }
            window.setAttributes(params);
            call.resolve();
        });
    }
}
