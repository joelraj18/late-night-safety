// Offline support + "Install app".
//
// The service worker (sw.js) saves the whole app, the face model and the
// tracking engine on the first visit, so afterwards the app opens and works
// with no internet at all. Inside the Android app everything is already
// bundled, so none of this is needed there.

import { isNativeApp } from './native.js';

export function setupPwa({ onStatus = () => {}, onUpdateReady = () => {}, onInstallable = () => {} } = {}) {
  if (isNativeApp()) {
    onStatus({ state: 'ready', native: true });
    return;
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    onInstallable(async () => {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      if (!prompt) return 'unavailable';
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      return outcome;
    });
  });
  window.addEventListener('appinstalled', () => onInstallable(null));

  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    onStatus({ state: 'unsupported' });
    return;
  }

  const sw = navigator.serviceWorker;
  let reloadOnTakeover = false;
  sw.addEventListener('controllerchange', () => {
    if (reloadOnTakeover) {
      reloadOnTakeover = false;
      location.reload();
    }
  });
  sw.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'precache-progress') onStatus({ state: 'saving', done: d.done, total: d.total });
    if (d.type === 'cache-status') onStatus({ state: d.done >= d.total ? 'ready' : 'saving', done: d.done, total: d.total });
    if (d.type === 'precache-error') onStatus({ state: 'error', message: d.message });
  });

  const askStatus = (worker) => worker?.postMessage({ type: 'cache-status' });

  const watch = (worker, reg) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && sw.controller) {
        onUpdateReady(() => {
          reloadOnTakeover = true;
          (reg.waiting || worker).postMessage({ type: 'skip-waiting' });
        });
      }
      if (worker.state === 'activated') askStatus(worker);
      if (worker.state === 'redundant' && !sw.controller) onStatus({ state: 'error' });
    });
  };

  sw.register('./sw.js', { scope: './' })
    .then((reg) => {
      if (reg.installing) {
        onStatus({ state: 'saving' });
        watch(reg.installing, reg);
      }
      if (reg.waiting && sw.controller) {
        onUpdateReady(() => {
          reloadOnTakeover = true;
          reg.waiting.postMessage({ type: 'skip-waiting' });
        });
      }
      reg.addEventListener('updatefound', () => watch(reg.installing, reg));
      if (reg.active) askStatus(reg.active);
      // Look for a newer version now and then (only does anything when online).
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    })
    .catch((err) => onStatus({ state: 'error', message: String(err?.message || err) }));
}
