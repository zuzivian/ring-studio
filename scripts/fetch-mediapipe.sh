#!/bin/sh
# Downloads the MediaPipe hand landmarker into vendor/mediapipe so the site
# serves it itself instead of fetching it from jsDelivr and Google each visit.
# Run once from the repo root, then commit vendor/mediapipe.
set -eu
V=0.10.14
BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V"
DEST=vendor/mediapipe
mkdir -p "$DEST/wasm"
curl -fL "$BASE/vision_bundle.mjs" -o "$DEST/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  curl -fL "$BASE/wasm/$f" -o "$DEST/wasm/$f"
done
curl -fL "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" -o "$DEST/hand_landmarker.task"
ls -la "$DEST" "$DEST/wasm"
echo "Done. Commit vendor/mediapipe and push."
