// Faceted gemstone geometry.
//
// Every cut is built in "unit" space: width 1 along X, length = ratio along Z,
// girdle centred on y = 0, table facing +Y. -Z points toward the fingertip.
// A cut returns triangles (flat shaded, one normal per facet), the facet planes
// used by the ray tracer in the gem shader, its volume, and outline helpers the
// setting builder uses for prongs, halos and bezels.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Outlines: dense closed polylines in the XZ plane, counter-clockwise seen from
// above, with arc-length lookup.
// ---------------------------------------------------------------------------

class Outline {
  constructor(points) {
    // drop duplicate closing point
    const p = points.slice();
    const a = p[0], b = p[p.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) p.pop();
    // enforce counter-clockwise when seen from +Y (x right, -z up on screen):
    // signed area in (x, -z) must be positive.
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length];
      area += x0 * -z1 - x1 * -z0;
    }
    if (area < 0) p.reverse();
    this.pts = p;
    this.cum = [0];
    for (let i = 0; i < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length];
      this.cum.push(this.cum[i] + Math.hypot(x1 - x0, z1 - z0));
    }
    this.length = this.cum[p.length];
    // area centroid
    let A = 0, cx = 0, cz = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length];
      const cr = x0 * z1 - x1 * z0;
      A += cr; cx += (x0 + x1) * cr; cz += (z0 + z1) * cr;
    }
    A *= 0.5;
    this.area = Math.abs(A);
    this.centroid = [cx / (6 * A), cz / (6 * A)];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of p) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  // u in [0,1) along the perimeter, starting at pts[0]
  pointAt(u) {
    u = ((u % 1) + 1) % 1;
    const s = u * this.length;
    let lo = 0, hi = this.pts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid; else hi = mid;
    }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length];
    const seg = this.cum[lo + 1] - this.cum[lo];
    const t = seg > 0 ? (s - this.cum[lo]) / seg : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // u of the outline point whose direction from the centroid is closest to
  // the polar angle theta (theta measured from +X toward -Z, i.e. north = 90°)
  uAtAngle(theta) {
    const [cx, cz] = this.centroid;
    let best = 0, bestD = Infinity;
    const n = this.pts.length;
    for (let i = 0; i < n; i++) {
      const [x, z] = this.pts[i];
      const a = Math.atan2(-(z - cz), x - cx);
      let d = Math.abs(((a - theta) % TAU + TAU + Math.PI) % TAU - Math.PI);
      if (d < bestD) { bestD = d; best = i; }
    }
    return this.cum[best] / this.length;
  }

  uAtIndex(i) { return this.cum[i] / this.length; }
}

// outward unit normal (in XZ) at u, averaged over a small window
Outline.prototype.normalAt = function (u, win = 0.004) {
  const a = this.pointAt(u - win), b = this.pointAt(u + win);
  const tx = b[0] - a[0], tz = b[1] - a[1];
  const l = Math.hypot(tx, tz) || 1;
  // Tangent runs counter-clockwise seen from above (x right, -z up). Rotating
  // the screen-space tangent (tx, -tz) clockwise gives the outward normal
  // (-tz, -tx) on screen, which is (−tz, tx) back in (x, z).
  return [-tz / l, tx / l];
};

function polyline(fn, n = 720) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(fn((i / n) * TAU));
  return pts;
}

// polygon vertices → dense outline + the u positions of the vertices
function polygonOutline(verts, perEdge = 40) {
  const pts = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    for (let k = 0; k < perEdge; k++) {
      const t = k / perEdge;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return new Outline(pts);
}

// samples for polygons: vertices at even indices, edges split evenly
function polygonSamples(outline, nVerts, count) {
  const per = count / nVerts;
  const us = [];
  for (let v = 0; v < nVerts; v++) {
    const u0 = outline.uAtIndex(v * 40 % outline.pts.length);
    const u1 = v + 1 < nVerts ? outline.uAtIndex(((v + 1) * 40) % outline.pts.length) : 1;
    for (let k = 0; k < per; k++) us.push(u0 + ((u1 - u0) * k) / per);
  }
  return us;
}

// arc-length samples starting at u0 (an anchor such as a pear tip)
function arcSamples(count, u0 = 0) {
  const us = [];
  for (let i = 0; i < count; i++) us.push(u0 + i / count);
  return us;
}

function rotateToStart(points, index) {
  return points.slice(index).concat(points.slice(0, index));
}

// --- individual shapes (width 1 along X, length L along Z) -----------------

function circleOutline() {
  return new Outline(polyline((t) => [0.5 * Math.cos(t), -0.5 * Math.sin(t)]));
}
function ellipseOutline(L) {
  return new Outline(polyline((t) => [0.5 * Math.cos(t), -0.5 * L * Math.sin(t)]));
}
function superellipseOutline(L, n) {
  return new Outline(
    polyline((t) => {
      const c = Math.cos(t), s = Math.sin(t);
      return [0.5 * Math.sign(c) * Math.abs(c) ** (2 / n), -0.5 * L * Math.sign(s) * Math.abs(s) ** (2 / n)];
    })
  );
}

function pearOutline(L) {
  // round end (radius 0.5) toward +z, point toward -z
  const c = L / 2 - 0.5; // circle centre z
  const h = L - 0.5;
  const R = 0.25 + h * h; // side arc radius
  const cxR = 0.5 - R; // right arc centre x
  const alpha = Math.atan2(-L / 2 - c, 0 - cxR); // angle at tip (negative)
  const pts = [];
  // start at tip, go down the right side (+x) to the round end, around, up the left side
  const nSide = 260, nRound = 200;
  for (let i = 0; i <= nSide; i++) {
    const a = alpha + (0 - alpha) * (i / nSide);
    pts.push([cxR + R * Math.cos(a), c + R * Math.sin(a)]);
  }
  for (let i = 1; i < nRound; i++) {
    const a = (Math.PI * i) / nRound;
    pts.push([0.5 * Math.cos(a), c + 0.5 * Math.sin(a)]);
  }
  for (let i = 0; i < nSide; i++) {
    const a = 0 + (alpha - 0) * (i / nSide);
    pts.push([-(cxR + R * Math.cos(a)), c + R * Math.sin(a)]);
  }
  return { outline: new Outline(pts), tipFirst: true };
}

function marquiseOutline(L) {
  const x0 = 0.25 - (L * L) / 4; // right arc centre (negative)
  const R = 0.5 - x0;
  const a1 = Math.atan2(-L / 2, -x0); // to the north tip
  const pts = [];
  const n = 360;
  for (let i = 0; i < n; i++) {
    const a = a1 + (-a1 - a1) * (i / n); // right arc from north tip to south tip
    pts.push([x0 + R * Math.cos(a), R * Math.sin(a)]);
  }
  for (let i = 0; i < n; i++) {
    const a = -a1 + (a1 - -a1) * (i / n);
    pts.push([-(x0 + R * Math.cos(a)), R * Math.sin(a)]);
  }
  return new Outline(pts);
}

function heartOutline(L) {
  // lobes toward -z (fingertip), point toward +z; built at width 1, length 1 then stretched
  const rl = 0.27, lx = 0.5 - rl, lz = -0.16;
  const tip = [0, 0.5];
  // tangent from tip to right lobe circle (outer tangent)
  const dx = lx - tip[0], dz = lz - tip[1];
  const d = Math.hypot(dx, dz);
  const base = Math.atan2(dz, dx);
  const off = Math.asin(rl / d);
  const tAng = base + off; // direction of tangent line from tip
  const tl = Math.sqrt(d * d - rl * rl);
  const tp = [tip[0] + tl * Math.cos(tAng), tip[1] + tl * Math.sin(tAng)]; // tangent point
  // lobe arc from tangent point, around the outside, to the cleft
  const cleftZ = lz - Math.sqrt(rl * rl - lx * lx);
  const aStart = Math.atan2(tp[1] - lz, tp[0] - lx);
  const aEnd = Math.atan2(cleftZ - lz, 0 - lx) + TAU; // go the long way around (counter direction)
  const pts = [];
  const nLine = 160, nArc = 300;
  // right side: tip → tangent point
  for (let i = 0; i < nLine; i++) {
    const t = i / nLine;
    pts.push([tip[0] + (tp[0] - tip[0]) * t, tip[1] + (tp[1] - tip[1]) * t]);
  }
  // right lobe: aStart decreasing? choose direction that passes the outer side (x max)
  let a0 = aStart, a1 = aEnd;
  // we want to sweep through angle 0 (rightmost point) then -90 (top) to the cleft
  // angles in (x, z): rightmost = 0, top (most negative z) = -PI/2
  a1 = Math.atan2(cleftZ - lz, -lx); // cleft angle (around -2.3 rad)
  // sweep from a0 (positive, ~+0.9) down through 0, -PI/2 to a1 (~ -2.6)
  if (a1 > a0) a1 -= TAU;
  for (let i = 0; i <= nArc; i++) {
    const a = a0 + (a1 - a0) * (i / nArc);
    pts.push([lx + rl * Math.cos(a), lz + rl * Math.sin(a)]);
  }
  // mirror for the left half (reverse order, skip duplicates at cleft & tip)
  const right = pts.slice();
  for (let i = right.length - 2; i > 0; i--) pts.push([-right[i][0], right[i][1]]);
  // normalise to width 1 and length L
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const w = maxX - minX, hgt = maxZ - minZ, cz = (minZ + maxZ) / 2;
  const scaled = pts.map(([x, z]) => [x / w, ((z - cz) / hgt) * L]);
  return { outline: new Outline(scaled), cleftIndex: right.length - 1 };
}

function chamferedRect(L, c) {
  // width 1, length L, corner chamfer c (in width units)
  const x = 0.5, z = L / 2;
  if (c <= 0) return [[x, z], [x, -z], [-x, -z], [-x, z]];
  return [
    [x, z - c], [x, -z + c], [x - c, -z], [-x + c, -z],
    [-x, -z + c], [-x, z - c], [-x + c, z], [x - c, z],
  ];
}

function trillionVerts(L) {
  // equilateral-ish triangle, point toward -z
  return [[0, -L / 2], [-0.5, L / 2], [0.5, L / 2]];
}

// ---------------------------------------------------------------------------
// Facet assembly
// ---------------------------------------------------------------------------

class FacetMesh {
  constructor() { this.facets = []; }
  // pts: array of [x,y,z]; side: 'up' | 'down' | [nx,nz] outward hint | 'any'
  add(pts, side) {
    const clean = [];
    for (const p of pts) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 1e-7) clean.push(p);
    }
    while (clean.length > 1) {
      const a = clean[0], b = clean[clean.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-7) clean.pop(); else break;
    }
    if (clean.length < 3) return;
    let n = newell(clean);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-10) return;
    n = n.map((v) => v / len);
    let flip = false;
    if (side === 'up') flip = n[1] < 0;
    else if (side === 'down') flip = n[1] > 0;
    else if (Array.isArray(side)) flip = n[0] * side[0] + n[2] * side[1] < 0;
    if (flip) { clean.reverse(); n = n.map((v) => -v); }
    let d = 0;
    for (const p of clean) d += n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
    d /= clean.length;
    this.facets.push({ pts: clean, n, d, girdle: side !== 'up' && side !== 'down' });
  }

  toGeometry() {
    const pos = [], nor = [];
    for (const f of this.facets) {
      const p0 = f.pts[0];
      for (let i = 1; i < f.pts.length - 1; i++) {
        const p1 = f.pts[i], p2 = f.pts[i + 1];
        pos.push(...p0, ...p1, ...p2);
        nor.push(...f.n, ...f.n, ...f.n);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  volume() {
    let v = 0;
    for (const f of this.facets) {
      const p0 = f.pts[0];
      for (let i = 1; i < f.pts.length - 1; i++) {
        const p1 = f.pts[i], p2 = f.pts[i + 1];
        v += p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0]);
      }
    }
    return v / 6;
  }

  // planes for the ray tracer: [nx, ny, nz, d] with n·p = d on the plane
  tracePlanes({ girdleChords = null, convexOnly = false } = {}) {
    let list = this.facets.filter((f) => !(girdleChords && f.girdle)).map((f) => [...f.n, f.d]);
    if (girdleChords) list = list.concat(girdleChords);
    // merge near-identical planes
    const merged = [];
    for (const p of list) {
      if (!merged.some((q) => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] > 0.99999 && Math.abs(q[3] - p[3]) < 1e-5)) merged.push(p);
    }
    if (!convexOnly) return merged;
    const verts = this.facets.flatMap((f) => f.pts);
    // drop only planes that cut deep into the stone (the concave cleft of a heart);
    // slightly non-planar facets elsewhere stay.
    return merged.filter((p) => verts.every((v) => p[0] * v[0] + p[1] * v[1] + p[2] * v[2] <= p[3] + 0.03));
  }
}

function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

// height on the plane through three points at (x, z)
function planeY(a, b, c, x, z) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (Math.abs(ny) < 1e-12) return a[1];
  return a[1] - (nx * (x - a[0]) + nz * (z - a[2])) / ny;
}

// fraction along segment a→b (XZ) of the projection of m
function projParam(a, b, m) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  return ((m[0] - a[0]) * dx + (m[1] - a[1]) * dz) / l2;
}

const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// ---------------------------------------------------------------------------
// Brilliant cut (round brilliant topology, generalised to any outline)
// ---------------------------------------------------------------------------

function buildBrilliant(outline, us, p) {
  const n2 = us.length, N = n2 / 2;
  const sub = p.subdiv || 1;
  const c = outline.centroid;
  const g = p.girdle;
  const yG = g / 2, yGb = -g / 2;
  const hc = 0.5 * (1 - p.table) * Math.tan(deg(p.crownAngle));
  const hp = 0.5 * Math.tan(deg(p.pavilionAngle));
  const yT = yG + hc, yC = yGb - hp;
  const G = us.map((u) => outline.pointAt(u));
  const scaleFrom = (pt, f) => [c[0] + (pt[0] - c[0]) * f, c[1] + (pt[1] - c[1]) * f];

  // table
  const T = [];
  for (let k = 0; k < N; k++) T.push(scaleFrom(G[2 * k], p.table));
  // star points
  const tm = p.table * Math.cos(Math.PI / n2);
  const fs = tm + p.star * (1 - tm);
  const S = [];
  for (let k = 0; k < N; k++) S.push(scaleFrom(G[2 * k + 1], fs));
  const SY = new Array(N).fill(0), SYn = new Array(N).fill(0);
  for (let k = 0; k < N; k++) {
    // kite k: T_k, S_{k-1}, G_{2k}, S_k
    const km = (k - 1 + N) % N;
    const M = lerp2(S[km], S[k], 0.5);
    const u = Math.min(Math.max(projParam(T[k], G[2 * k], M), 0), 1);
    const y = yT + (yG - yT) * u;
    SY[k] += y; SYn[k]++;
    SY[km] += y; SYn[km]++;
  }
  const S3 = S.map((s, k) => [s[0], SY[k] / SYn[k], s[1]]);
  const T3 = T.map((t) => [t[0], yT, t[1]]);
  const G3t = G.map((q) => [q[0], yG, q[1]]);
  const G3b = G.map((q) => [q[0], yGb, q[1]]);

  // pavilion lower-girdle points and culet
  const fl = 1 - p.lowerHalf;
  const L = [];
  for (let k = 0; k < N; k++) L.push(scaleFrom(G[2 * k + 1], fl));
  const LY = new Array(N).fill(0), LYn = new Array(N).fill(0);
  for (let k = 0; k < N; k++) {
    const km = (k - 1 + N) % N;
    const M = lerp2(L[km], L[k], 0.5);
    const u = Math.min(Math.max(projParam(G[2 * k], c, M), 0), 1);
    const y = yGb + (yC - yGb) * u;
    LY[k] += y; LYn[k]++;
    LY[km] += y; LYn[km]++;
  }
  const L3 = L.map((l, k) => [l[0], LY[k] / LYn[k], l[1]]);
  const C3 = [c[0], yC, c[1]];
  const culet = p.culet || 0;
  const Cu3 = [];
  for (let k = 0; k < N; k++) {
    const q = scaleFrom(G[2 * k + 1], culet);
    Cu3.push([q[0], yC, q[1]]);
  }

  // dense girdle ring with scalloped top/bottom heights
  const ringTop = [], ringBot = [], ringIdx = [];
  for (let i = 0; i < n2; i++) {
    const u0 = us[i], u1 = i + 1 < n2 ? us[i + 1] : us[0] + 1;
    const k = i >> 1;
    for (let s = 0; s < sub; s++) {
      const u = u0 + ((u1 - u0) * s) / sub;
      const q = outline.pointAt(u);
      let yt = yG, yb = yGb;
      if (s > 0) {
        // facet planes: upper girdle (S_k with G_i, G_i+1), lower girdle (L_k with G_i, G_i+1)
        const a = G3t[i], b = G3t[(i + 1) % n2];
        yt = Math.min(yG, planeY(S3[k], a, b, q[0], q[1]));
        const ab = G3b[i], bb = G3b[(i + 1) % n2];
        yb = Math.max(yGb, planeY(L3[k], ab, bb, q[0], q[1]));
        const minGap = g * 0.25;
        if (yt - yb < minGap) { const mid = (yt + yb) / 2; yt = mid + minGap / 2; yb = mid - minGap / 2; }
      }
      ringTop.push([q[0], yt, q[1]]);
      ringBot.push([q[0], yb, q[1]]);
      ringIdx.push(i);
    }
  }
  const R = ringTop.length;
  const seg = (i) => {
    // ring points from sample i to sample i+1 inclusive
    const out = [];
    for (let s = 0; s <= sub; s++) out.push((i * sub + s) % R);
    return out;
  };

  const fm = new FacetMesh();
  fm.add(T3.slice(), 'up');
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N, km = (k - 1 + N) % N;
    fm.add([T3[k], T3[k1], S3[k]], 'up'); // star
    fm.add([T3[k], S3[km], ringTop[2 * k * sub], S3[k]], 'up'); // bezel kite
    // upper girdle facets
    fm.add([S3[k], ...seg(2 * k).map((j) => ringTop[j])], 'up');
    fm.add([S3[k], ...seg(2 * k + 1).map((j) => ringTop[j])], 'up');
    // lower girdle facets
    fm.add([L3[k], ...seg(2 * k).map((j) => ringBot[j])], 'down');
    fm.add([L3[k], ...seg(2 * k + 1).map((j) => ringBot[j])], 'down');
    // pavilion main
    if (culet > 0.001) fm.add([ringBot[2 * k * sub], L3[k], Cu3[k], Cu3[km], L3[km]], 'down');
    else fm.add([ringBot[2 * k * sub], L3[k], C3, L3[km]], 'down');
  }
  if (culet > 0.001) fm.add(Cu3.slice(), 'down');
  // girdle band
  for (let j = 0; j < R; j++) {
    const j1 = (j + 1) % R;
    const nrm = outline.normalAt(((us[ringIdx[j]] + us[ringIdx[j1]] + (j1 === 0 ? 1 : 0)) / 2));
    fm.add([ringTop[j], ringTop[j1], ringBot[j1], ringBot[j]], nrm);
  }
  // chord planes for the tracer, one per sample segment
  const chords = [];
  for (let i = 0; i < n2; i++) {
    const a = G[i], b = G[(i + 1) % n2];
    let nx = b[1] - a[1], nz = -(b[0] - a[0]);
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    const mid = lerp2(a, b, 0.5);
    if (nx * (mid[0] - c[0]) + nz * (mid[1] - c[1]) < 0) { nx = -nx; nz = -nz; }
    chords.push([nx, 0, nz, nx * a[0] + nz * a[1]]);
  }
  return { fm, yTop: yT, yBottom: yC, crownHeight: hc, pavilionDepth: hp, chords, keel: null };
}

// ---------------------------------------------------------------------------
// Step cut (emerald, asscher, baguette): rings scaled toward a keel line
// ---------------------------------------------------------------------------

function buildStep(verts, p) {
  const outline = polygonOutline(verts);
  const g = p.girdle;
  const yG = g / 2, yGb = -g / 2;
  const { minX, maxX, minZ, maxZ } = outline.bounds;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const W = maxX - minX, Lz = maxZ - minZ;
  const along = Lz >= W;
  const half = Math.abs(Lz - W) / 2;
  const keelPt = (v) => {
    if (along) return [cx, cz + Math.max(-half, Math.min(half, v[1] - cz))];
    return [cx + Math.max(-half, Math.min(half, v[0] - cx)), cz];
  };
  const ring = (s) => verts.map((v) => { const k = keelPt(v); return [k[0] + (v[0] - k[0]) * s, k[1] + (v[1] - k[1]) * s]; });
  const halfMinor = Math.min(W, Lz) / 2;

  // crown: girdle → steps → table
  const crownS = [1, ...p.crownSteps, p.table];
  const crown = [];
  let y = yG;
  crown.push(ring(1).map((q) => [q[0], y, q[1]]));
  for (let i = 1; i < crownS.length; i++) {
    const dIn = halfMinor * (crownS[i - 1] - crownS[i]);
    y += dIn * Math.tan(deg(p.crownAngles[i - 1]));
    crown.push(ring(crownS[i]).map((q) => [q[0], y, q[1]]));
  }
  const yT = y;
  const pavS = [1, ...p.pavSteps, 0];
  const pav = [];
  y = yGb;
  pav.push(ring(1).map((q) => [q[0], y, q[1]]));
  for (let i = 1; i < pavS.length; i++) {
    const dIn = halfMinor * (pavS[i - 1] - pavS[i]);
    y -= dIn * Math.tan(deg(p.pavAngles[i - 1]));
    pav.push(ring(pavS[i]).map((q) => [q[0], y, q[1]]));
  }
  const yC = y;
  const fm = new FacetMesh();
  const V = verts.length;
  for (let r = 0; r < crown.length - 1; r++) {
    for (let j = 0; j < V; j++) {
      const j1 = (j + 1) % V;
      fm.add([crown[r][j], crown[r][j1], crown[r + 1][j1], crown[r + 1][j]], 'up');
    }
  }
  fm.add(crown[crown.length - 1].slice(), 'up');
  for (let r = 0; r < pav.length - 1; r++) {
    for (let j = 0; j < V; j++) {
      const j1 = (j + 1) % V;
      fm.add([pav[r][j], pav[r][j1], pav[r + 1][j1], pav[r + 1][j]], 'down');
    }
  }
  for (let j = 0; j < V; j++) {
    const j1 = (j + 1) % V;
    const a = verts[j], b = verts[j1];
    fm.add([[a[0], yG, a[1]], [b[0], yG, b[1]], [b[0], yGb, b[1]], [a[0], yGb, a[1]]], outwardOf(a, b, [cx, cz]));
  }
  return {
    fm, outline, yTop: yT, yBottom: yC, crownHeight: yT - yG, pavilionDepth: yGb - yC,
    keel: { along, half, cx, cz },
  };
}

function outwardOf(a, b, c) {
  let nx = b[1] - a[1], nz = -(b[0] - a[0]);
  const mid = lerp2(a, b, 0.5);
  if (nx * (mid[0] - c[0]) + nz * (mid[1] - c[1]) < 0) { nx = -nx; nz = -nz; }
  return [nx, nz];
}

// ---------------------------------------------------------------------------
// Rose cut: flat base, domed crown of triangles
// ---------------------------------------------------------------------------

function buildRose(outline, p) {
  const n2 = 12, N = 6;
  const us = arcSamples(n2, 0);
  const c = outline.centroid;
  const g = p.girdle;
  const yG = g / 2, yGb = -g / 2;
  const H = p.dome;
  const G = us.map((u) => outline.pointAt(u));
  const G3 = G.map((q) => [q[0], yG, q[1]]);
  const A = [];
  for (let i = 0; i < N; i++) {
    const q = G[2 * i + 1];
    A.push([c[0] + (q[0] - c[0]) * 0.52, yG + H * 0.62, c[1] + (q[1] - c[1]) * 0.52]);
  }
  const apex = [c[0], yG + H, c[1]];
  const fm = new FacetMesh();
  for (let i = 0; i < N; i++) {
    const i1 = (i + 1) % N;
    fm.add([apex, A[i], A[i1]], 'up');
    fm.add([A[i], G3[2 * i], G3[2 * i + 1]], 'up');
    fm.add([A[i], G3[2 * i + 1], G3[(2 * i + 2) % n2]], 'up');
    fm.add([A[i], G3[(2 * i + 2) % n2], A[i1]], 'up');
  }
  // girdle band: subdivide for a smoother outline
  const sub = 3;
  const top = [], bot = [];
  for (let i = 0; i < n2; i++) {
    for (let s = 0; s < sub; s++) {
      const u = us[i] + (1 / n2) * (s / sub);
      const q = outline.pointAt(u);
      top.push(s === 0 ? G3[i] : [q[0], yG, q[1]]);
      bot.push([q[0], yGb, q[1]]);
    }
  }
  // the crown triangles only reach the 12 sample points; fill the slivers
  for (let i = 0; i < n2; i++) {
    const k = Math.floor(i / 2);
    const apexPt = A[k];
    const pts = [];
    for (let s = 0; s <= sub; s++) pts.push(top[(i * sub + s) % top.length]);
    if (sub > 1) fm.add([apexPt, ...pts], 'up');
  }
  for (let j = 0; j < top.length; j++) {
    const j1 = (j + 1) % top.length;
    fm.add([top[j], top[j1], bot[j1], bot[j]], outwardOf([top[j][0], top[j][2]], [top[j1][0], top[j1][2]], c));
  }
  fm.add(bot.slice(), 'down');
  return { fm, yTop: yG + H, yBottom: yGb, crownHeight: H, pavilionDepth: 0, keel: null };
}

// ---------------------------------------------------------------------------
// Cut catalogue
// ---------------------------------------------------------------------------

// Proportions are GIA-style: table and girdle as fractions of width, angles in degrees.
export const CUTS = {
  round: { label: 'Round', family: 'brilliant', ratio: [1, 1, 1], props: { table: 0.57, crownAngle: 34.5, pavilionAngle: 40.75, girdle: 0.03, star: 0.5, lowerHalf: 0.77, culet: 0 }, prongs: { options: [4, 6, 8], default: 6 } },
  oval: { label: 'Oval', family: 'brilliant', ratio: [1.25, 1.4, 1.7], props: { table: 0.58, crownAngle: 34, pavilionAngle: 41, girdle: 0.03, star: 0.5, lowerHalf: 0.8, culet: 0 }, prongs: { options: [4, 6], default: 4 } },
  cushion: { label: 'Cushion', family: 'brilliant', ratio: [1, 1.05, 1.15], props: { table: 0.6, crownAngle: 35, pavilionAngle: 42, girdle: 0.035, star: 0.5, lowerHalf: 0.78, culet: 0 }, prongs: { options: [4, 'double'], default: 4 } },
  elongatedCushion: { label: 'Elongated cushion', family: 'brilliant', ratio: [1.2, 1.35, 1.6], props: { table: 0.6, crownAngle: 35, pavilionAngle: 42, girdle: 0.035, star: 0.5, lowerHalf: 0.78, culet: 0 }, prongs: { options: [4, 'double'], default: 4 } },
  princess: { label: 'Princess', family: 'brilliant', ratio: [1, 1, 1.1], props: { table: 0.7, crownAngle: 33, pavilionAngle: 49, girdle: 0.035, star: 0.45, lowerHalf: 0.8, culet: 0 }, prongs: { options: [4], default: 4 } },
  radiant: { label: 'Radiant', family: 'brilliant', ratio: [1, 1.25, 1.5], props: { table: 0.66, crownAngle: 34, pavilionAngle: 47, girdle: 0.035, star: 0.45, lowerHalf: 0.8, culet: 0 }, prongs: { options: [4, 'double'], default: 4 } },
  emerald: { label: 'Emerald', family: 'step', ratio: [1.3, 1.45, 1.7], props: { table: 0.64, girdle: 0.03, crownAngle: 0, pavilionAngle: 0 }, prongs: { options: [4, 'double'], default: 4 } },
  asscher: { label: 'Asscher', family: 'step', ratio: [1, 1, 1.05], props: { table: 0.58, girdle: 0.03, crownAngle: 0, pavilionAngle: 0 }, prongs: { options: [4, 'double'], default: 4 } },
  pear: { label: 'Pear', family: 'brilliant', ratio: [1.45, 1.6, 1.8], props: { table: 0.58, crownAngle: 34, pavilionAngle: 41.5, girdle: 0.03, star: 0.5, lowerHalf: 0.8, culet: 0 }, prongs: { options: [3, 5], default: 5 } },
  marquise: { label: 'Marquise', family: 'brilliant', ratio: [1.75, 2, 2.3], props: { table: 0.58, crownAngle: 34, pavilionAngle: 41.5, girdle: 0.03, star: 0.5, lowerHalf: 0.8, culet: 0 }, prongs: { options: [4, 6], default: 6 } },
  heart: { label: 'Heart', family: 'brilliant', ratio: [0.9, 1, 1.15], props: { table: 0.58, crownAngle: 34, pavilionAngle: 41, girdle: 0.03, star: 0.5, lowerHalf: 0.8, culet: 0 }, prongs: { options: [3, 5], default: 3 } },
  oldEuropean: { label: 'Old European', family: 'brilliant', ratio: [1, 1, 1], props: { table: 0.45, crownAngle: 40, pavilionAngle: 41.5, girdle: 0.025, star: 0.42, lowerHalf: 0.55, culet: 0.07 }, prongs: { options: [4, 6, 8], default: 6 } },
  oldMine: { label: 'Old mine', family: 'brilliant', ratio: [1, 1.05, 1.15], props: { table: 0.45, crownAngle: 40, pavilionAngle: 41, girdle: 0.025, star: 0.42, lowerHalf: 0.55, culet: 0.08 }, prongs: { options: [4, 'double'], default: 4 } },
  rose: { label: 'Rose cut', family: 'rose', ratio: [1, 1, 1.5], props: { girdle: 0.04, dome: 0.34 }, prongs: { options: [6, 'bezel'], default: 6 } },
  trillion: { label: 'Trillion', family: 'brilliant', ratio: [0.87, 0.87, 0.95], props: { table: 0.62, crownAngle: 32, pavilionAngle: 43, girdle: 0.035, star: 0.45, lowerHalf: 0.75, culet: 0 }, prongs: { options: [3], default: 3 } },
  baguette: { label: 'Baguette', family: 'step', ratio: [1.8, 2.5, 4], props: { table: 0.7, girdle: 0.03, crownAngle: 0, pavilionAngle: 0 }, prongs: { options: [4], default: 4 } },
  taperedBaguette: { label: 'Tapered baguette', family: 'step', ratio: [1.8, 2.2, 3], props: { table: 0.66, girdle: 0.03, crownAngle: 0, pavilionAngle: 0 }, prongs: { options: [4], default: 4 }, sideOnly: true },
};

// cut quality presets for brilliant cuts (applied as deltas from the ideal)
export const CUT_GRADES = {
  ideal: { label: 'Ideal', table: 0, crownAngle: 0, pavilionAngle: 0 },
  excellent: { label: 'Excellent', table: 0.01, crownAngle: 0.5, pavilionAngle: 0.1 },
  veryGood: { label: 'Very good', table: 0.03, crownAngle: -2, pavilionAngle: 0.5 },
  good: { label: 'Good', table: 0.05, crownAngle: -4, pavilionAngle: 1.2 },
  fairShallow: { label: 'Fair (shallow)', table: 0.08, crownAngle: -7, pavilionAngle: -2.5 },
  poorDeep: { label: 'Poor (deep)', table: -0.02, crownAngle: 4, pavilionAngle: 3.2 },
};

const cache = new Map();

// Build a gem in unit space. opts: { cut, ratio, props (overrides) }
export function buildGem(cutKey, ratio, propsOverride = {}) {
  const key = JSON.stringify([cutKey, ratio, propsOverride]);
  if (cache.has(key)) return cache.get(key);
  const def = CUTS[cutKey] || CUTS.round;
  const p = { ...def.props, ...propsOverride };
  const L = ratio || def.ratio[1];
  let res, outline, convexOnly = false;

  switch (cutKey) {
    case 'oval': outline = ellipseOutline(L); break;
    case 'cushion': case 'elongatedCushion': outline = superellipseOutline(L, 3.4); break;
    case 'oldMine': outline = superellipseOutline(L, 3.0); break;
    case 'round': case 'oldEuropean': case 'rose': outline = cutKey === 'rose' && L > 1.01 ? ellipseOutline(L) : circleOutline(); break;
    default: break;
  }

  if (def.family === 'brilliant') {
    let us;
    const count = cutKey === 'trillion' ? 12 : 16;
    if (cutKey === 'princess' || cutKey === 'radiant' || cutKey === 'trillion') {
      const verts = cutKey === 'princess' ? chamferedRect(L, 0) : cutKey === 'radiant' ? chamferedRect(L, 0.14) : trillionVerts(L);
      const trillion = cutKey === 'trillion';
      // slightly bowed sides for trillions
      outline = polygonOutline(verts);
      if (trillion) {
        const c = outline.centroid;
        outline = new Outline(outline.pts.map(([x, z], i) => {
          const t = (i % 40) / 40; const bow = 0.06 * Math.sin(Math.PI * t);
          const dx = x - c[0], dz = z - c[1]; const l = Math.hypot(dx, dz) || 1;
          return [x + (dx / l) * bow, z + (dz / l) * bow];
        }));
      }
      us = polygonSamples(outline, verts.length, count);
    } else if (cutKey === 'pear') {
      outline = pearOutline(L).outline;
      us = arcSamples(count, 0);
    } else if (cutKey === 'marquise') {
      outline = marquiseOutline(L);
      us = arcSamples(count, 0);
    } else if (cutKey === 'heart') {
      outline = heartOutline(L).outline;
      us = arcSamples(count, 0);
      convexOnly = true;
    } else {
      us = arcSamples(count, 0);
    }
    res = buildBrilliant(outline, us, { ...p, subdiv: count === 16 ? 3 : 3 });
    res.outline = outline;
    res.planes = res.fm.tracePlanes({ girdleChords: res.chords, convexOnly });
  } else if (def.family === 'step') {
    let verts, prm;
    if (cutKey === 'emerald') {
      verts = chamferedRect(L, 0.15);
      prm = { ...p, crownSteps: [0.88, 0.76], crownAngles: [46, 36, 26], pavSteps: [0.8, 0.56, 0.3], pavAngles: [58, 48, 41, 34] };
    } else if (cutKey === 'asscher') {
      verts = chamferedRect(L, 0.23);
      prm = { ...p, crownSteps: [0.86, 0.72], crownAngles: [48, 40, 32], pavSteps: [0.8, 0.58, 0.34], pavAngles: [60, 50, 43, 36] };
    } else if (cutKey === 'taperedBaguette') {
      const z = L / 2;
      verts = [[0.5, -z], [-0.5, -z], [-0.32, z], [0.32, z]];
      prm = { ...p, crownSteps: [0.84], crownAngles: [40, 30], pavSteps: [0.7, 0.38], pavAngles: [55, 46, 38] };
    } else {
      verts = chamferedRect(L, 0);
      prm = { ...p, crownSteps: [0.84], crownAngles: [40, 30], pavSteps: [0.7, 0.38], pavAngles: [55, 46, 38] };
    }
    res = buildStep(verts, prm);
    outline = res.outline;
    res.planes = res.fm.tracePlanes();
  } else {
    if (!outline) outline = circleOutline();
    res = buildRose(outline, p);
    res.outline = outline;
    res.planes = res.fm.tracePlanes();
  }

  const geometry = res.fm.toGeometry();
  const volume = res.fm.volume();
  const b = outline.bounds;
  const gem = {
    cut: cutKey,
    def,
    ratio: L,
    props: p,
    geometry,
    planes: res.planes,
    volume, // unit^3
    outline,
    width: b.maxX - b.minX,
    length: b.maxZ - b.minZ,
    yTop: res.yTop,
    yBottom: res.yBottom,
    girdle: p.girdle,
    crownHeight: res.crownHeight,
    pavilionDepth: res.pavilionDepth,
    keel: res.keel,
    depth: res.yTop - res.yBottom,
    facetCount: res.fm.facets.length,
  };
  cache.set(key, gem);
  return gem;
}

// Pavilion surface point under outline position u at fraction f (0 = girdle, 1 = culet), unit space
export function pavilionPoint(gem, u, f) {
  const P = gem.outline.pointAt(u);
  let K;
  if (gem.keel) {
    const { along, half, cx, cz } = gem.keel;
    K = along ? [cx, cz + Math.max(-half, Math.min(half, P[1] - cz))] : [cx + Math.max(-half, Math.min(half, P[0] - cx)), cz];
  } else K = gem.outline.centroid;
  const yGb = -gem.girdle / 2;
  // pavilion of brilliant cuts bows slightly outward; linear is close enough for metalwork
  return [P[0] + (K[0] - P[0]) * f, yGb + (gem.yBottom - yGb) * f, P[1] + (K[1] - P[1]) * f];
}

// Crown surface height just inside the girdle (for prong tips), unit space
export function crownHeightAt(gem, inset) {
  const slope = gem.crownHeight / Math.max(0.05, 0.5 * (1 - (gem.props.table || 0.6)));
  return gem.girdle / 2 + Math.min(gem.crownHeight, inset * slope);
}

// Gem materials: refractive index (sodium D line), dispersion (B–G), density g/cm³
export const GEM_TYPES = {
  diamond: { label: 'Natural diamond', ior: 2.417, dispersion: 0.044, density: 3.515, kind: 'diamond' },
  labDiamond: { label: 'Lab-grown diamond', ior: 2.417, dispersion: 0.044, density: 3.515, kind: 'diamond' },
  moissanite: { label: 'Moissanite', ior: 2.65, dispersion: 0.104, density: 3.21, kind: 'colorless', tint: [0.985, 0.995, 0.97] },
  cz: { label: 'Cubic zirconia', ior: 2.16, dispersion: 0.06, density: 5.8, kind: 'colorless' },
  whiteSapphire: { label: 'White sapphire', ior: 1.77, dispersion: 0.018, density: 4.0, kind: 'colorless' },
  sapphire: { label: 'Sapphire', ior: 1.77, dispersion: 0.018, density: 4.0, kind: 'colored', varieties: 'sapphire' },
  ruby: { label: 'Ruby', ior: 1.77, dispersion: 0.018, density: 4.0, kind: 'colored', varieties: 'ruby' },
  emerald: { label: 'Emerald', ior: 1.58, dispersion: 0.014, density: 2.72, kind: 'colored', varieties: 'emerald', haze: 0.05 },
  morganite: { label: 'Morganite', ior: 1.59, dispersion: 0.014, density: 2.8, kind: 'colored', varieties: 'morganite' },
  aquamarine: { label: 'Aquamarine', ior: 1.58, dispersion: 0.014, density: 2.7, kind: 'colored', varieties: 'aquamarine' },
  alexandrite: { label: 'Alexandrite', ior: 1.75, dispersion: 0.015, density: 3.73, kind: 'colored', varieties: 'alexandrite' },
  tanzanite: { label: 'Tanzanite', ior: 1.69, dispersion: 0.019, density: 3.35, kind: 'colored', varieties: 'tanzanite' },
  spinel: { label: 'Spinel', ior: 1.718, dispersion: 0.02, density: 3.6, kind: 'colored', varieties: 'spinel' },
  amethyst: { label: 'Amethyst', ior: 1.55, dispersion: 0.013, density: 2.65, kind: 'colored', varieties: 'amethyst' },
  garnet: { label: 'Garnet', ior: 1.76, dispersion: 0.022, density: 3.9, kind: 'colored', varieties: 'garnet' },
  topaz: { label: 'Topaz', ior: 1.62, dispersion: 0.014, density: 3.53, kind: 'colored', varieties: 'topaz' },
  tourmaline: { label: 'Tourmaline', ior: 1.62, dispersion: 0.017, density: 3.06, kind: 'colored', varieties: 'tourmaline' },
  peridot: { label: 'Peridot', ior: 1.67, dispersion: 0.02, density: 3.34, kind: 'colored', varieties: 'peridot' },
  citrine: { label: 'Citrine', ior: 1.55, dispersion: 0.013, density: 2.65, kind: 'colored', varieties: 'citrine' },
  onyx: { label: 'Black onyx', ior: 1.54, dispersion: 0.013, density: 2.65, kind: 'opaque', body: [0.02, 0.02, 0.022] },
};

// transmitted colour after 10 mm of travel (linear RGB), per variety
export const VARIETIES = {
  sapphire: { royal: { label: 'Royal blue', t: [0.03, 0.09, 0.62] }, cornflower: { label: 'Cornflower', t: [0.18, 0.32, 0.82] }, ceylon: { label: 'Ceylon (light blue)', t: [0.42, 0.56, 0.9] }, teal: { label: 'Teal (Montana)', t: [0.12, 0.42, 0.42] }, padparadscha: { label: 'Padparadscha', t: [0.95, 0.42, 0.34] }, pink: { label: 'Pink', t: [0.9, 0.3, 0.55] }, yellow: { label: 'Yellow', t: [0.95, 0.78, 0.2] }, green: { label: 'Green', t: [0.32, 0.6, 0.3] } },
  ruby: { pigeon: { label: "Pigeon's blood", t: [0.82, 0.03, 0.08] }, pinkish: { label: 'Pinkish red', t: [0.9, 0.18, 0.3] }, deep: { label: 'Deep red', t: [0.55, 0.01, 0.04] } },
  emerald: { colombian: { label: 'Colombian green', t: [0.08, 0.6, 0.25] }, zambian: { label: 'Zambian (bluish)', t: [0.05, 0.42, 0.3] }, light: { label: 'Light green', t: [0.4, 0.8, 0.5] } },
  morganite: { peach: { label: 'Peach', t: [0.98, 0.72, 0.6] }, pink: { label: 'Pink', t: [0.97, 0.7, 0.74] } },
  aquamarine: { santaMaria: { label: 'Santa Maria blue', t: [0.45, 0.75, 0.95] }, light: { label: 'Light sea blue', t: [0.7, 0.9, 0.95] } },
  alexandrite: { change: { label: 'Colour change', t: [0.3, 0.55, 0.35], alt: [0.6, 0.2, 0.35] } },
  tanzanite: { violet: { label: 'Violet blue', t: [0.28, 0.2, 0.78] }, blue: { label: 'Blue', t: [0.15, 0.22, 0.75] } },
  spinel: { red: { label: 'Red', t: [0.85, 0.06, 0.12] }, pink: { label: 'Hot pink', t: [0.95, 0.22, 0.55] }, lavender: { label: 'Lavender', t: [0.7, 0.6, 0.85] }, black: { label: 'Black', t: [0.01, 0.01, 0.012] } },
  amethyst: { deep: { label: 'Deep purple', t: [0.45, 0.12, 0.7] }, rose: { label: 'Rose de France', t: [0.85, 0.65, 0.92] } },
  garnet: { rhodolite: { label: 'Rhodolite', t: [0.7, 0.1, 0.3] }, tsavorite: { label: 'Tsavorite green', t: [0.12, 0.65, 0.2] }, mandarin: { label: 'Mandarin orange', t: [0.98, 0.35, 0.05] } },
  topaz: { london: { label: 'London blue', t: [0.12, 0.32, 0.5] }, swiss: { label: 'Swiss blue', t: [0.35, 0.7, 0.9] }, imperial: { label: 'Imperial', t: [0.98, 0.6, 0.25] } },
  tourmaline: { paraiba: { label: 'Paraíba neon', t: [0.05, 0.85, 0.82] }, pink: { label: 'Pink', t: [0.95, 0.35, 0.6] }, green: { label: 'Green', t: [0.3, 0.6, 0.25] } },
  peridot: { classic: { label: 'Olive green', t: [0.55, 0.8, 0.12] } },
  citrine: { golden: { label: 'Golden', t: [0.98, 0.72, 0.22] }, madeira: { label: 'Madeira', t: [0.85, 0.38, 0.08] } },
};

// Diamond colour grades → yellow absorption strength (per mm, blue channel)
export const COLOR_GRADES = [
  ['D', 0], ['E', 0.0012], ['F', 0.0025], ['G', 0.0045], ['H', 0.007], ['I', 0.0105], ['J', 0.015],
  ['K', 0.021], ['L', 0.028], ['M', 0.036], ['N', 0.046], ['O–P', 0.06], ['Q–R', 0.077], ['S–T', 0.098], ['U–V', 0.125], ['W–X', 0.155], ['Y–Z', 0.19],
];

// Fancy coloured diamonds: transmitted colour at 10 mm for "Fancy" intensity
export const FANCY_COLORS = {
  yellow: { label: 'Yellow (canary)', t: [0.97, 0.82, 0.25] },
  pink: { label: 'Pink', t: [0.95, 0.55, 0.66] },
  blue: { label: 'Blue', t: [0.45, 0.62, 0.95] },
  green: { label: 'Green', t: [0.5, 0.85, 0.5] },
  champagne: { label: 'Champagne', t: [0.92, 0.75, 0.55] },
  cognac: { label: 'Cognac', t: [0.85, 0.48, 0.18] },
  orange: { label: 'Orange', t: [0.98, 0.55, 0.15] },
  purple: { label: 'Purple', t: [0.7, 0.45, 0.85] },
  red: { label: 'Red', t: [0.85, 0.15, 0.2] },
  grey: { label: 'Grey (salt and pepper)', t: [0.55, 0.56, 0.58], haze: 0.06, inclusions: 10 },
  black: { label: 'Black', t: [0.005, 0.005, 0.006], opaque: true },
};
export const FANCY_INTENSITY = { faint: 0.25, light: 0.5, fancy: 1, intense: 1.6, vivid: 2.3, deep: 3.2 };

export const CLARITY = {
  FL: { count: 0, size: 0, haze: 0 }, IF: { count: 0, size: 0, haze: 0 },
  VVS1: { count: 1, size: 0.008, haze: 0 }, VVS2: { count: 2, size: 0.01, haze: 0 },
  VS1: { count: 2, size: 0.014, haze: 0 }, VS2: { count: 3, size: 0.017, haze: 0 },
  SI1: { count: 3, size: 0.024, haze: 0.004 }, SI2: { count: 4, size: 0.032, haze: 0.008 },
  I1: { count: 5, size: 0.045, haze: 0.016 }, I2: { count: 7, size: 0.06, haze: 0.03 }, I3: { count: 10, size: 0.075, haze: 0.06 },
};

export const FLUORESCENCE = { none: 0, faint: 0.15, medium: 0.35, strong: 0.65, veryStrong: 1 };

// mm³ of material per carat
export function mm3PerCarat(density) { return 200 / density; }

// unit-space gem → scale (mm per unit) for a given carat weight
export function scaleForCarat(gem, carat, density) {
  const target = carat * mm3PerCarat(density);
  return Math.cbrt(target / gem.volume);
}

// deterministic inclusion positions inside the gem (unit space)
export function makeInclusions(gem, clarityKey, extraCount = 0, seed = 7) {
  const c = CLARITY[clarityKey] || CLARITY.VS1;
  const count = Math.min(8, c.count + extraCount);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const out = [];
  const bb = gem.geometry.boundingBox;
  let guard = 0;
  while (out.length < count && guard++ < 4000) {
    const x = bb.min.x + (bb.max.x - bb.min.x) * (0.2 + 0.6 * rnd());
    const y = gem.yBottom * 0.55 + (gem.yTop * 0.6 - gem.yBottom * 0.55) * rnd();
    const z = bb.min.z + (bb.max.z - bb.min.z) * (0.2 + 0.6 * rnd());
    if (gem.planes.every((p) => p[0] * x + p[1] * y + p[2] * z < p[3] - 0.04)) {
      const r = c.size * (0.6 + 0.8 * rnd());
      out.push([x, y, z, r]);
    }
  }
  return { list: out, haze: c.haze };
}

// SVG path for shape picker icons (top view)
export function outlineSvgPath(cutKey, size = 40) {
  const def = CUTS[cutKey];
  const gem = buildGem(cutKey, def.ratio[1]);
  const pts = gem.outline.pts;
  const b = gem.outline.bounds;
  const w = b.maxX - b.minX, l = b.maxZ - b.minZ;
  const sc = (size * 0.8) / Math.max(w, l);
  const ox = size / 2 - ((b.minX + b.maxX) / 2) * sc, oz = size / 2 - ((b.minZ + b.maxZ) / 2) * sc;
  let d = '';
  const step = Math.max(1, Math.floor(pts.length / 120));
  for (let i = 0; i < pts.length; i += step) d += (i ? 'L' : 'M') + (pts[i][0] * sc + ox).toFixed(2) + ' ' + (pts[i][1] * sc + oz).toFixed(2);
  return d + 'Z';
}
