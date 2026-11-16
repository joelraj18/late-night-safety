#!/usr/bin/env bash
# Re-downloads the on-device face tracking runtime (MediaPipe Tasks Vision) and
# the Face Landmarker model into ./vendor, and verifies their checksums.
#
# The app serves these files itself (instead of from a CDN) so that, after the
# first visit, it keeps working with no internet connection.
#
# Version note: 0.10.35 is deliberately pinned. Newer 1.x releases add a
# usage-metrics call to Google (odml.pa.googleapis.com); 0.10.35 makes no
# network requests of its own.
set -euo pipefail

MP_VERSION="0.10.35"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/mediapipe"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching @mediapipe/tasks-vision@$MP_VERSION from npm..."
(cd "$TMP" && npm pack "@mediapipe/tasks-vision@$MP_VERSION" --silent >/dev/null && tar xzf ./*.tgz)

mkdir -p "$DEST/$MP_VERSION/wasm" "$DEST/models"
cp "$TMP/package/vision_bundle.mjs" "$DEST/$MP_VERSION/vision_bundle.js"  # .js so every web server (and the Android app) serves it as JavaScript
cp "$TMP/package/wasm/vision_wasm_internal.js" "$DEST/$MP_VERSION/wasm/"
cp "$TMP/package/wasm/vision_wasm_internal.wasm" "$DEST/$MP_VERSION/wasm/"

echo "Fetching face_landmarker.task model..."
curl -fsSL -o "$DEST/models/face_landmarker.task" "$MODEL_URL"

echo "Verifying checksums..."
(cd "$DEST" && sha256sum -c SHA256SUMS)
echo "Done."
