// Automatic placement from a photo: find the hand with MediaPipe's hand
// landmarker, then measure the ring finger, its 3D direction and the way the
// back of the hand faces, and read the light direction off the skin shading.
//
// MediaPipe landmarks: 0 wrist; 5/9/13/17 index/middle/ring/pinky knuckles
// (MCP); 14 ring finger middle joint (PIP). Image landmarks are normalised
// x, y with z a relative depth (smaller = nearer the camera).

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// where along the ring finger's first bone the ring sits (0 = knuckle, 1 = middle joint)
const RING_T = 0.47;

let landmarkerPromise = null;

export function loadHandLandmarker() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const { FilesetResolver, HandLandmarker } = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'IMAGE',
      numHands: 2,
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
    });
    try { return await make('GPU'); } catch (e) { return await make('CPU'); }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; });
  return landmarkerPromise;
}

// Returns the raw MediaPipe-style result: { landmarks: [[{x,y,z}...21]], worldLandmarks, handedness }
async function runDetector(canvas) {
  if (window.__mockHands) return window.__mockHands; // automated tests
  const lm = await loadHandLandmarker();
  return lm.detect(canvas);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

/**
 * photo: { canvas, w, h, gray, gw, gh, gs }
 * Returns null when no hand is found, otherwise
 * { a, b, tip: [dx, dy], fz, up: [x,y,z] (world: x right, y up, z to camera), light: { azimuth, strength }, points }
 */
export async function detectRingFinger(photo) {
  const res = await runDetector(photo.canvas);
  if (!res || !res.landmarks || !res.landmarks.length) return null;
  // the biggest hand in the frame
  let best = 0, bestArea = -1;
  res.landmarks.forEach((l, i) => {
    const xs = l.map((p) => p.x), ys = l.map((p) => p.y);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (area > bestArea) { bestArea = area; best = i; }
  });
  const L = res.landmarks[best];
  const P = L.map((p) => [p.x * photo.w, p.y * photo.h]);

  // ring position and in-image fingertip direction
  const m = P[13], j = P[14];
  const c = [m[0] + (j[0] - m[0]) * RING_T, m[1] + (j[1] - m[1]) * RING_T];
  let tx = j[0] - m[0], ty = j[1] - m[1];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  const px = -ty, py = tx; // across the finger

  // finger width: knuckle spacing is a good prior, then snap to the skin edges
  const spacing = (Math.hypot(P[13][0] - P[9][0], P[13][1] - P[9][1]) + Math.hypot(P[13][0] - P[17][0], P[13][1] - P[17][1])) / 2;
  const prior = spacing * 0.9;
  const edges = findEdges(photo, c, [px, py], prior);
  const w = edges ? edges.width : prior;
  const off = edges ? edges.offset : 0;
  const cc = [c[0] + px * off, c[1] + py * off];
  const a = [cc[0] - px * w / 2, cc[1] - py * w / 2];
  const b = [cc[0] + px * w / 2, cc[1] + py * w / 2];

  // 3D: how steeply the finger points toward or away from the camera, and
  // which way its back faces. Built from the image landmarks (x, y in pixels,
  // z = MediaPipe's relative depth on the same scale as x), so the frame lines
  // up with the photo by construction. MediaPipe's depth is noisy, so the
  // result is damped and kept within 45° of facing the camera; the tilt and
  // turn sliders cover the rest.
  const I = L.map((p) => [p.x * photo.w, -p.y * photo.h, -p.z * photo.w]);
  const F3 = norm(sub(I[14], I[13]));
  const fz = Math.max(-0.5, Math.min(0.5, F3[2] * 0.7));
  const across = norm(sub(I[17], I[9]));
  let up = norm(cross(across, F3));
  if (up[2] < 0) up = up.map((v) => -v); // the back of the hand faces the camera
  let hand = norm(cross(sub(I[5], I[0]), sub(I[17], I[0])));
  if (hand[2] < 0) hand = hand.map((v) => -v);
  up = norm(up.map((v, i) => v * 0.5 + hand[i] * 0.5));
  // damp toward the camera and cap the lean at 45°
  up = norm([up[0] * 0.6, up[1] * 0.6, up[2]]);
  const lean = Math.hypot(up[0], up[1]);
  if (lean > Math.SQRT1_2) { const k = Math.SQRT1_2 / lean; up = norm([up[0] * k, up[1] * k, Math.SQRT1_2]); }

  return {
    a, b, tip: [tx, ty], fz, up,
    widthSource: edges ? 'edges' : 'knuckles',
    light: estimateLight(photo, P, w),
    points: P,
  };
}

// strongest luminance edges either side of the finger centre, along `dir`
function findEdges(photo, c, dir, prior) {
  const { gray, gw, gh, gs } = photo;
  const at = (x, y) => {
    const gx = Math.min(gw - 1, Math.max(0, Math.round(x * gs))), gy = Math.min(gh - 1, Math.max(0, Math.round(y * gs)));
    return gray[gy * gw + gx];
  };
  // average a few rows along the finger to beat skin texture
  const tip = [dir[1], -dir[0]];
  const profile = (s) => {
    let v = 0;
    for (const t of [-0.12, -0.06, 0, 0.06, 0.12]) v += at(c[0] + dir[0] * s + tip[0] * prior * t, c[1] + dir[1] * s + tip[1] * prior * t);
    return v / 5;
  };
  const step = Math.max(0.5, prior / 80);
  const grad = (s) => profile(s + step * 2) - profile(s - step * 2);
  const search = (sign) => {
    let best = 0, at = 0;
    for (let s = prior * 0.28; s <= prior * 0.78; s += step) {
      const g = Math.abs(grad(sign * s));
      const w = 1 - Math.abs(s - prior / 2) / prior; // prefer the expected half-width
      if (g * w > best) { best = g * w; at = s; }
    }
    return { strength: best, s: at };
  };
  const l = search(-1), r = search(1);
  if (l.strength < 6 || r.strength < 6) return null;
  const width = l.s + r.s;
  if (width < prior * 0.7 || width > prior * 1.3) return null;
  return { width, offset: (r.s - l.s) / 2 };
}

// Which way the light falls across the back of the hand. Fits a plane to skin
// brightness over the hand and adds the shading across each finger, which
// behaves like a lit cylinder. Returns the direction the light comes from as a
// clockwise angle from the top of the photo, and how directional it is (0 = flat, soft light).
function estimateLight(photo, P, fingerW) {
  const { gray, gw, gh, gs } = photo;
  const at = (x, y) => {
    let v = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const gx = Math.round(x * gs) + dx, gy = Math.round(y * gs) + dy;
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
      v += gray[gy * gw + gx]; n++;
    }
    return n ? v / n : 0;
  };
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  // samples on the back of the hand
  const pts = [];
  for (const k of [5, 9, 13, 17]) for (const t of [0.3, 0.5, 0.7, 0.85]) pts.push(lerp(P[0], P[k], t));
  for (const [a, b] of [[5, 9], [9, 13], [13, 17]]) for (const t of [0.2, 0.5, 0.8]) pts.push(lerp(lerp(P[0], P[a], 0.75), lerp(P[0], P[b], 0.75), t));
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const scale = Math.hypot(P[9][0] - P[0][0], P[9][1] - P[0][1]) || 1;
  // least squares L = a + b*x + c*y (x, y in hand lengths)
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, S1 = 0, SL = 0, SxL = 0, SyL = 0;
  for (const p of pts) {
    const x = (p[0] - cx) / scale, y = (p[1] - cy) / scale, l = at(p[0], p[1]);
    Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; S1++; SL += l; SxL += x * l; SyL += y * l;
  }
  const mean = SL / S1;
  const det = Sxx * Syy - Sxy * Sxy || 1;
  let gx = (SxL * Syy - SyL * Sxy) / det, gy = (SyL * Sxx - SxL * Sxy) / det;
  // across-finger shading on the four fingers' first bones
  let fx = 0, fy = 0;
  for (const [mcp, pip] of [[5, 6], [9, 10], [13, 14], [17, 18]]) {
    const c = lerp(P[mcp], P[pip], 0.55);
    let tx = P[pip][0] - P[mcp][0], ty = P[pip][1] - P[mcp][1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx, r = fingerW * 0.28;
    const d = at(c[0] + nx * r, c[1] + ny * r) - at(c[0] - nx * r, c[1] - ny * r);
    fx += nx * d; fy += ny * d;
  }
  // the back of the hand curves away at its edges, so its gradient is only a
  // weak hint; the shading across the fingers carries most of the weight
  gx = gx * 0.15 + fx / 4;
  gy = gy * 0.15 + fy / 4;
  const strength = Math.min(1, Math.hypot(gx, gy) / Math.max(20, mean));
  const azimuth = Math.round((Math.atan2(gx, -gy) * 180) / Math.PI);
  return { azimuth, strength, mean };
}
