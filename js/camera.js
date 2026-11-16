// Front camera access with friendly error messages.

export class CameraError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind; // denied | notfound | busy | insecure | unsupported | unknown
    this.cause = cause;
  }
}

const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } };

function toCameraError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraError(
        'denied',
        'Camera access is blocked. Allow the camera for this app (tap the lock or ⓘ icon next to the address, or Android Settings → Apps → permissions), then try again.',
        e,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('notfound', 'No camera was found on this device.', e);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('busy', 'The camera is being used by another app. Close it and try again.', e);
    case 'SecurityError':
      return new CameraError('insecure', 'The camera needs a secure (https://) connection.', e);
    default:
      return new CameraError('unknown', `Could not start the camera (${e?.name || e?.message || e}).`, e);
  }
}

export function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Opens the chosen camera (or the front camera) and returns its MediaStream. */
export async function openCamera({ deviceId = '' } = {}) {
  if (!window.isSecureContext) {
    throw new CameraError('insecure', 'The camera only works over https:// (or on localhost). Open the app from its https address.');
  }
  if (!cameraSupported()) throw new CameraError('unsupported', 'This browser cannot use the camera. Try Chrome.');
  const get = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video });
  try {
    return await get(deviceId ? { ...VIDEO, deviceId: { exact: deviceId } } : { ...VIDEO, facingMode: 'user' });
  } catch (e) {
    // The saved camera may be gone (e.g. a USB webcam unplugged): use the default one.
    if (deviceId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) return openCamera({});
    if (e?.name === 'OverconstrainedError') {
      try {
        return await get(true);
      } catch (e2) {
        throw toCameraError(e2);
      }
    }
    throw toCameraError(e);
  }
}

export function stopStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

export async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

/** 'granted' | 'denied' | 'prompt' | 'unknown' */
export async function cameraPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state;
  } catch {
    return 'unknown';
  }
}
