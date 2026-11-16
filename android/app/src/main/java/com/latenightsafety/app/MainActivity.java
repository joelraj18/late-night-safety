package com.latenightsafety.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native helper for keep-screen-on and brightness (see ScreenControlPlugin).
        registerPlugin(ScreenControlPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
