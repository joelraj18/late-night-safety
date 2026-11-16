// Helpers for when the app runs inside the Android app (Capacitor WebView)
// instead of a normal browser. Capacitor injects `window.Capacitor`, and our
// small native plugin (android/.../ScreenControlPlugin.java) appears as
// `window.Capacitor.Plugins.ScreenControl`.

export function isNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export function nativePlugin(name) {
  if (!isNativeApp()) return null;
  return window.Capacitor?.Plugins?.[name] ?? null;
}

export function platformName() {
  if (isNativeApp()) return 'android-app';
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

export function isStandalone() {
  return (
    isNativeApp() ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    navigator.standalone === true
  );
}
