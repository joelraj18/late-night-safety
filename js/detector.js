// On-device face tracking with MediaPipe Face Landmarker (478 face points +
// blendshapes such as eyeBlinkLeft/Right and jawOpen).
//
// Everything is served from this app's own folder (vendor/), never a CDN, so
// it keeps working offline and no camera data ever leaves the device.

const MP_ROOT = new URL('../vendor/mediapipe/', import.meta.url);
const MP_VERSION = '0.10.35';

export const DETECTOR_ASSETS = Object.freeze({
  bundle: new URL(`${MP_VERSION}/vision_bundle.js`, MP_ROOT).href,
  wasmLoader: new URL(`${MP_VERSION}/wasm/vision_wasm_internal.js`, MP_ROOT).href,
  wasmBinary: new URL(`${MP_VERSION}/wasm/vision_wasm_internal.wasm`, MP_ROOT).href,
  model: new URL('models/face_landmarker.task', MP_ROOT).href,
});

// Tiny WebAssembly module using a SIMD instruction (from wasm-feature-detect).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function wasmSimdSupported() {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

let modelBytes = null;
async function loadModel() {
  if (!modelBytes) {
    const res = await fetch(DETECTOR_ASSETS.model);
    if (!res.ok) throw new Error(`Could not load the face model (HTTP ${res.status}).`);
    modelBytes = new Uint8Array(await res.arrayBuffer());
  }
  return modelBytes;
}

function landmarkerOptions(model, delegate) {
  return {
    baseOptions: { modelAssetBuffer: model.slice(), delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

class Detector {
  constructor(FaceLandmarker, fileset, model, landmarker, delegate) {
    Object.assign(this, { FaceLandmarker, fileset, model, landmarker, delegate });
    this.lastTs = 0;
    this.errors = 0;
  }

  /** Runs on one video frame. Throws if the tracker is broken. */
  detect(source, nowMs) {
    const ts = Math.max(Math.round(nowMs), this.lastTs + 1); // must strictly increase
    this.lastTs = ts;
    try {
      const result = this.landmarker.detectForVideo(source, ts);
      this.errors = 0;
      return result;
    } catch (e) {
      this.errors += 1;
      throw e;
    }
  }

  /** The GPU path can fail on some phones mid-run; switch to CPU once. */
  async switchToCpu() {
    if (this.delegate === 'CPU') return false;
    try {
      this.landmarker.close();
    } catch {
      /* ignore */
    }
    this.landmarker = await this.FaceLandmarker.createFromOptions(this.fileset, landmarkerOptions(this.model, 'CPU'));
    this.delegate = 'CPU';
    this.errors = 0;
    return true;
  }

  close() {
    try {
      this.landmarker.close();
    } catch {
      /* ignore */
    }
  }
}

export async function createDetector({ useGPU = true } = {}) {
  if (!wasmSimdSupported()) {
    throw new Error('This browser is too old for the face tracker (needs WebAssembly SIMD). Please update Chrome / Safari.');
  }
  const [{ FaceLandmarker }, model] = await Promise.all([import(DETECTOR_ASSETS.bundle), loadModel()]);
  const fileset = { wasmLoaderPath: DETECTOR_ASSETS.wasmLoader, wasmBinaryPath: DETECTOR_ASSETS.wasmBinary };
  let lastError;
  for (const delegate of useGPU ? ['GPU', 'CPU'] : ['CPU']) {
    try {
      const landmarker = await FaceLandmarker.createFromOptions(fileset, landmarkerOptions(model, delegate));
      return new Detector(FaceLandmarker, fileset, model, landmarker, delegate);
    } catch (e) {
      lastError = e;
      console.warn(`Face tracker could not start on ${delegate}`, e);
    }
  }
  throw lastError ?? new Error('The face tracker could not start.');
}

// Indices of the eye and lip outlines, for drawing the overlay.
export const OUTLINES = {
  rightEye: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 33],
  leftEye: [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382, 362],
  mouth: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78],
};
