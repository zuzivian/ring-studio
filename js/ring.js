// Ring assembly in millimetres.
//
// Ring frame: the finger runs along Z (−Z toward the fingertip), +Y is the top
// of the finger where the head sits, +X runs across the finger. The band is a
// sweep around Z; angle φ = 0 at the top, increasing toward +X.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGem, pavilionPoint, crownHeightAt, CUTS } from './gems.js';
import { L } from './layers.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// distance from the top of the band (φ = 0) going either way round, 0…π
const absAngle = (phi) => Math.abs(((phi + Math.PI) % TAU + TAU) % TAU - Math.PI);

// ---------------------------------------------------------------------------
// Band cross-sections
// ---------------------------------------------------------------------------

export const PROFILES = {
  domed: { label: 'Domed (court)' },
  halfround: { label: 'Half round' },
  flat: { label: 'Flat' },
  comfort: { label: 'Comfort fit' },
  knife: { label: 'Knife edge' },
  square: { label: 'Square' },
};

function profileHeights(type, W, T) {
  const u = (z) => clamp((2 * z) / W, -1, 1);
  let out, inn = () => 0;
  switch (type) {
    case 'halfround': out = (z) => T * (0.14 + 0.86 * Math.sqrt(Math.max(0, 1 - u(z) ** 2))); break;
    case 'flat': out = () => T; break;
    case 'square': out = () => T; break;
    case 'comfort': out = (z) => T * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - u(z) ** 2))); inn = (z) => T * 0.26 * u(z) ** 2; break;
    case 'knife': out = (z) => T * (0.36 + 0.64 * Math.pow(1 - Math.abs(u(z)), 1.1)); break;
    case 'domed': default: out = (z) => T * (0.45 + 0.55 * Math.sqrt(Math.max(0, 1 - u(z) ** 2))); break;
  }
  const rc = type === 'square' ? Math.min(0.12, W * 0.06) : Math.min(0.32, W * 0.14, T * 0.35);
  const ri = Math.min(0.18, W * 0.08);
  const edge = (z, r) => { const d = Math.abs(z) - (W / 2 - r); return d > 0 ? r - Math.sqrt(Math.max(0, r * r - d * d)) : 0; };
  return { out: (z) => out(z) - edge(z, rc), inn: (z) => inn(z) + edge(z, ri) };
}

const SECTION_K = 18;
// closed loop of [radialOffset, z] (mm) around the cross-section
function bandSection(type, W, T) {
  const { out, inn } = profileHeights(type, W, T);
  const K = SECTION_K;
  const pts = [];
  for (let i = 0; i <= K; i++) { const z = (W / 2) * Math.cos((Math.PI * i) / K); pts.push([out(z), z]); }
  const zl = -W / 2;
  for (let i = 1; i <= 2; i++) pts.push([out(zl) + ((inn(zl) - out(zl)) * i) / 3, zl]);
  for (let i = 0; i <= K; i++) { const z = -(W / 2) * Math.cos((Math.PI * i) / K); pts.push([inn(z), z]); }
  const zr = W / 2;
  for (let i = 1; i <= 2; i++) pts.push([inn(zr) + ((out(zr) - inn(zr)) * i) / 3, zr]);
  return chaikin(pts, 1);
}

function chaikin(pts, iters) {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = q;
  }
  return p;
}

function circleSection(r, n = 18) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

// Sweep a closed section around the finger axis. sectionAt(φ) → [[ρ, z], ...]
function sweepAroundAxis(phi0, phi1, n, sectionAt, { loop = false, caps = false, uScale = 6 } = {}) {
  const pos = [], uv = [], idx = [];
  const steps = loop ? n : n + 1;
  let M = 0;
  for (let j = 0; j < steps; j++) {
    const phi = phi0 + ((phi1 - phi0) * j) / n;
    const sec = sectionAt(phi);
    M = sec.length;
    for (let k = 0; k < M; k++) {
      const [rho, z] = sec[k];
      pos.push(rho * Math.sin(phi), rho * Math.cos(phi), z);
      uv.push((phi * rho) / uScale, k / M);
    }
  }
  const ring = (j) => (loop ? j % steps : j);
  for (let j = 0; j < (loop ? steps : steps - 1); j++) {
    for (let k = 0; k < M; k++) {
      const a = ring(j) * M + k, b = ring(j + 1) * M + k, c = ring(j + 1) * M + ((k + 1) % M), d = ring(j) * M + ((k + 1) % M);
      idx.push(a, b, c, a, c, d);
    }
  }
  if (caps && !loop) {
    for (const j of [0, steps - 1]) {
      const centre = pos.length / 3;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) { cx += pos[(j * M + k) * 3]; cy += pos[(j * M + k) * 3 + 1]; cz += pos[(j * M + k) * 3 + 2]; }
      // separate vertices so the cap gets a flat normal
      const capStart = pos.length / 3 + 1;
      pos.push(cx / M, cy / M, cz / M); uv.push(0, 0);
      for (let k = 0; k < M; k++) { pos.push(pos[(j * M + k) * 3], pos[(j * M + k) * 3 + 1], pos[(j * M + k) * 3 + 2]); uv.push(0, 0); }
      for (let k = 0; k < M; k++) {
        const a = capStart + k, b = capStart + ((k + 1) % M);
        if (j === 0) idx.push(centre, b, a); else idx.push(centre, a, b);
      }
    }
  }
  return finishGeometry(pos, uv, idx, (g) => outwardTest(g));
}

function finishGeometry(pos, uv, idx, orient) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (orient && !orient(g)) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

// true when the vertex farthest from the bounding-box centre has an outward normal
function outwardTest(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox.getCenter(c);
  let best = -1, bestD = -1;
  for (let i = 0; i < p.count; i++) {
    const d = (p.getX(i) - c.x) ** 2 + (p.getY(i) - c.y) ** 2 + (p.getZ(i) - c.z) ** 2;
    if (d > bestD) { bestD = d; best = i; }
  }
  const dx = p.getX(best) - c.x, dy = p.getY(best) - c.y, dz = p.getZ(best) - c.z;
  return dx * n.getX(best) + dy * n.getY(best) + dz * n.getZ(best) > 0;
}

// Tube along control points with a radius profile r(t), t ∈ [0,1]
function tube(points, radiusAt, { segments = 40, radial = 12, closed = false, capEnd = false } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  const frames = curve.computeFrenetFrames(segments, closed);
  const pos = [], uv = [], idx = [];
  const rows = closed ? segments : segments + 1;
  const P = new THREE.Vector3();
  for (let i = 0; i < rows; i++) {
    const t = i / segments;
    curve.getPointAt(t, P);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = radiusAt(t);
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * TAU;
      const cx = Math.cos(a), sy = Math.sin(a);
      pos.push(P.x + r * (cx * N.x + sy * B.x), P.y + r * (cx * N.y + sy * B.y), P.z + r * (cx * N.z + sy * B.z));
      uv.push(t, k / radial);
    }
  }
  for (let i = 0; i < (closed ? rows : rows - 1); i++) {
    const i1 = (i + 1) % rows;
    for (let k = 0; k < radial; k++) {
      const k1 = (k + 1) % radial;
      idx.push(i * radial + k, i1 * radial + k, i1 * radial + k1, i * radial + k, i1 * radial + k1, i * radial + k1);
    }
  }
  let g = finishGeometry(pos, uv, idx, null);
  // flip if normals point inward (check first ring)
  const n = g.attributes.normal, p = g.attributes.position;
  curve.getPointAt(0.5, P);
  const mid = Math.floor(rows / 2) * radial;
  const dx = p.getX(mid) - P.x, dy = p.getY(mid) - P.y, dz = p.getZ(mid) - P.z;
  if (dx * n.getX(mid) + dy * n.getY(mid) + dz * n.getZ(mid) < 0) g = finishGeometry(pos, uv, idx, () => false);
  if (capEnd) {
    const end = curve.getPointAt(1);
    const s = new THREE.SphereGeometry(radiusAt(1), 14, 10);
    s.translate(end.x, end.y, end.z);
    g = mergeGeometries([g, s.index ? s : s]);
  }
  return g;
}

// Sweep a closed profile along a closed (or open) path of frames.
// frames: [{ p: Vector3 (path point), c: Vector3 (point toward the stone centre), n: Vector3 (outward), up: Vector3 }]
// profile: [[k, nOff, yOff]] where position = lerp(c, p, k) + n * nOff + up * yOff
function sweepFrames(frames, profile, { closed = true, caps = false } = {}) {
  const pos = [], uv = [], idx = [];
  const M = profile.length;
  const tmp = new THREE.Vector3();
  frames.forEach((f, j) => {
    for (let k = 0; k < M; k++) {
      const [kk, no, yo] = profile[k];
      tmp.copy(f.c).lerp(f.p, kk).addScaledVector(f.n, no).addScaledVector(f.up, yo);
      pos.push(tmp.x, tmp.y, tmp.z);
      uv.push(j / frames.length, k / M);
    }
  });
  const R = frames.length;
  for (let j = 0; j < (closed ? R : R - 1); j++) {
    const j1 = (j + 1) % R;
    for (let k = 0; k < M; k++) {
      const k1 = (k + 1) % M;
      idx.push(j * M + k, j1 * M + k, j1 * M + k1, j * M + k, j1 * M + k1, j * M + k1);
    }
  }
  if (caps && !closed) {
    for (const j of [0, R - 1]) {
      const base = pos.length / 3;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) { cx += pos[(j * M + k) * 3]; cy += pos[(j * M + k) * 3 + 1]; cz += pos[(j * M + k) * 3 + 2]; }
      pos.push(cx / M, cy / M, cz / M); uv.push(0, 0);
      for (let k = 0; k < M; k++) { pos.push(pos[(j * M + k) * 3], pos[(j * M + k) * 3 + 1], pos[(j * M + k) * 3 + 2]); uv.push(0, 0); }
      for (let k = 0; k < M; k++) {
        const a = base + 1 + k, b = base + 1 + ((k + 1) % M);
        if (j === 0) idx.push(base, b, a); else idx.push(base, a, b);
      }
    }
  }
  return finishGeometry(pos, uv, idx, (g) => outwardTest(g));
}

// ---------------------------------------------------------------------------
// Stone frame helpers (gem unit space → stone frame millimetres)
// ---------------------------------------------------------------------------

class StoneFrame {
  constructor(gem, scale, matrix) {
    this.gem = gem;
    this.s = scale;
    this.m = matrix; // stone frame → ring frame
    this.yGt = (gem.girdle / 2) * scale;
    this.yGb = (-gem.girdle / 2) * scale;
    this.yCulet = gem.yBottom * scale;
    this.yTable = gem.yTop * scale;
    this.hp = gem.pavilionDepth * scale;
  }
  P(u) { const [x, z] = this.gem.outline.pointAt(u); return new THREE.Vector3(x * this.s, 0, z * this.s); }
  N(u) { const [x, z] = this.gem.outline.normalAt(u); return new THREE.Vector3(x, 0, z); }
  pav(u, f) { const [x, y, z] = pavilionPoint(this.gem, u, f); return new THREE.Vector3(x * this.s, y * this.s, z * this.s); }
  centre() { const [cx, cz] = this.gem.outline.centroid; return new THREE.Vector3(cx * this.s, 0, cz * this.s); }
  crownY(insetMm) { return crownHeightAt(this.gem, insetMm / this.s) * this.s; }
  // outline offset outward by d (mm), sampled n times, as frames
  offsetFrames(d, n, y = 0) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const p = this.P(u), nn = this.N(u);
      const q = p.clone().addScaledVector(nn, d);
      q.y = y;
      out.push({ p: q, n: nn, u });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Prongs
// ---------------------------------------------------------------------------

function prongLayout(cut, count, gem) {
  const o = gem.outline;
  const u = (deg) => o.uAtAngle((deg * Math.PI) / 180);
  const b = o.bounds;
  const cornerDeg = (Math.atan2(b.maxZ - b.minZ, b.maxX - b.minX) * 180) / Math.PI;
  const at = (list, kind = 'round') => list.map((d) => ({ u: u(d), kind }));
  switch (cut) {
    case 'round': case 'oldEuropean': case 'rose': {
      const n = typeof count === 'number' ? count : 6;
      const off = n === 4 ? 45 : n === 6 ? 30 : n === 8 ? 22.5 : 90;
      return at(Array.from({ length: n }, (_, i) => off + (360 * i) / n));
    }
    case 'oval':
      if (count === 6) return at([90, 270, 28, 152, 208, 332]);
      return at([90 - 38, 90 + 38, 270 - 38, 270 + 38]);
    case 'cushion': case 'elongatedCushion': case 'oldMine':
      if (count === 'double') return at([cornerDeg - 9, cornerDeg + 9, 180 - cornerDeg - 9, 180 - cornerDeg + 9, 180 + cornerDeg - 9, 180 + cornerDeg + 9, 360 - cornerDeg - 9, 360 - cornerDeg + 9], 'claw');
      // six: the four corners plus the middle of each long side
      if (count === 6) return at([cornerDeg, 180 - cornerDeg, 180 + cornerDeg, 360 - cornerDeg, 0, 180]);
      return at([cornerDeg, 180 - cornerDeg, 180 + cornerDeg, 360 - cornerDeg]);
    case 'princess':
      if (count === 6) return at([cornerDeg, 180 - cornerDeg, 180 + cornerDeg, 360 - cornerDeg], 'v').concat(at([0, 180]));
      return at([cornerDeg, 180 - cornerDeg, 180 + cornerDeg, 360 - cornerDeg], 'v');
    case 'radiant': case 'emerald': case 'asscher': case 'baguette': case 'taperedBaguette':
      if (count === 'double') return at([cornerDeg - 7, cornerDeg + 7, 180 - cornerDeg - 7, 180 - cornerDeg + 7, 180 + cornerDeg - 7, 180 + cornerDeg + 7, 360 - cornerDeg - 7, 360 - cornerDeg + 7], 'claw');
      if (count === 6) return at([cornerDeg, 180 - cornerDeg, 180 + cornerDeg, 360 - cornerDeg], 'claw').concat(at([0, 180]));
      return at([cornerDeg, 180 - cornerDeg, 180 + cornerDeg, 360 - cornerDeg], cut === 'baguette' || cut === 'taperedBaguette' ? 'v' : 'claw');
    case 'pear': {
      const tip = [{ u: 0, kind: 'v' }];
      if (count === 3) return tip.concat(at([270 - 55, 270 + 55]));
      if (count === 6) return tip.concat(at([270 - 85, 270 - 40, 270, 270 + 40, 270 + 85]));
      return tip.concat(at([270 - 78, 270 - 28, 270 + 28, 270 + 78]));
    }
    case 'marquise': {
      const tips = [{ u: 0, kind: 'v' }, { u: 0.5, kind: 'v' }];
      if (count === 4) return tips.concat(at([0, 180]));
      return tips.concat(at([22, 158, 202, 338]));
    }
    case 'heart': {
      const point = { u: o.uAtAngle(-Math.PI / 2), kind: 'v' };
      if (count === 5) return [point].concat(at([40, 140, 205, 335]));
      if (count === 6) return [point].concat(at([40, 140, 205, 335, 90]));
      return [point].concat(at([38, 142]));
    }
    case 'trillion': return at([90, 210, 330], 'v');
    default: return at([45, 135, 225, 315]);
  }
}

// one prong in the stone frame; r = prong radius (mm), style: round | claw | double
function prongGeometry(sf, u, kind, r, style, baseY, tight = false) {
  const parts = [];
  if (kind === 'v') return vTip(sf, u, r, baseY, tight);
  const P = sf.P(u), n = sf.N(u);
  const t = new THREE.Vector3(-n.z, 0, n.x);
  const offsets = style === 'double' || kind === 'claw-double' ? [-0.95, 0.95] : [0];
  const rr = offsets.length > 1 ? r * 0.64 : r;
  for (const o of offsets) {
    const Pp = P.clone().addScaledVector(t, o * rr);
    const pav = (f) => { const q = sf.pav(u, f); return q.addScaledVector(t, o * rr * (1 - f * 0.6)); };
    const crownInset = rr * 0.9;
    const tipY = sf.crownY(crownInset) + rr * 0.35;
    const claw = style === 'claw' || kind === 'claw';
    const pts = [
      pav(0.96).multiplyScalar(0.55).setY(baseY),
      pav(0.92).setY(sf.yCulet - 0.25).multiply(new THREE.Vector3(0.75, 1, 0.75)),
      pav(0.6).addScaledVector(n, rr * 1.0),
      pav(0.25).addScaledVector(n, rr * 0.95),
      Pp.clone().addScaledVector(n, rr * 0.72).setY(sf.yGb * 0.5),
      Pp.clone().addScaledVector(n, rr * 0.5).setY(sf.yGt + rr * 0.75),
      Pp.clone().addScaledVector(n, claw ? -rr * 0.85 : -rr * 0.3).setY(claw ? tipY - rr * 0.1 : tipY),
    ];
    const radiusAt = (tt) => {
      const base = rr * (1.12 - 0.12 * smooth(0, 0.4, tt));
      return claw ? base * (1 - 0.7 * smooth(0.78, 1, tt)) : base;
    };
    parts.push(tube(pts, radiusAt, { segments: 44, radial: 12, capEnd: !claw }));
  }
  return parts;
}

// chevron that guards a point (pear tip, marquise ends, princess corners)
function vTip(sf, u, r, baseY, tight = false) {
  const s = sf.s;
  const per = sf.gem.outline.length * s; // mm perimeter
  const spanU = Math.min(0.08, 1.2 / per);
  // inside a halo the chevron is slimmer so it does not bury the first ring of halo stones
  const thick = tight ? Math.max(0.28, r * 0.55) : Math.max(0.38, r * 0.75);
  const outer = [], inner = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const uu = u - spanU + (2 * spanU * i) / n;
    const p = sf.P(uu), nn = sf.N(uu);
    outer.push(p.clone().addScaledVector(nn, thick));
    inner.push(p.clone().addScaledVector(nn, -0.2));
  }
  const shape = new THREE.Shape();
  const all = outer.concat(inner.reverse());
  all.forEach((p, i) => (i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z)));
  shape.closePath();
  const bottom = sf.yGb - Math.max(0.5, sf.hp * 0.18);
  const top = sf.crownY(0.2) + 0.12;
  const g = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 2, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, bottom, 0);
  const parts = [g.toNonIndexed ? g : g];
  // a post from the chevron down to the base
  const P = sf.P(u), nn = sf.N(u);
  const pts = [
    sf.pav(u, 0.95).multiplyScalar(0.55).setY(baseY),
    sf.pav(u, 0.9).setY(sf.yCulet - 0.25).multiply(new THREE.Vector3(0.75, 1, 0.75)),
    sf.pav(u, 0.5).addScaledVector(nn, r * 0.9),
    P.clone().addScaledVector(nn, r * 0.4).setY(bottom + 0.1),
  ];
  parts.push(tube(pts, () => r * 0.9, { segments: 24, radial: 10 }));
  return parts;
}

// ---------------------------------------------------------------------------
// Ring assembly
// ---------------------------------------------------------------------------

export const HEAD_STYLES = {
  solitaire: { label: 'Solitaire (prongs)' },
  cathedral: { label: 'Cathedral solitaire' },
  hiddenHalo: { label: 'Hidden halo' },
  halo: { label: 'Halo' },
  doubleHalo: { label: 'Double halo' },
  bezel: { label: 'Bezel' },
  halfBezel: { label: 'Half bezel' },
  threeStone: { label: 'Three stone' },
  fiveStone: { label: 'Five stone' },
  toiEtMoi: { label: 'Toi et moi (two stones)' },
  tension: { label: 'Tension' },
};

export const SHANKS = {
  plain: { label: 'Plain' },
  tapered: { label: 'Tapered' },
  split: { label: 'Split shank' },
  twist: { label: 'Twisted' },
};

export const ACCENTS = {
  none: { label: 'None' },
  pave: { label: 'Pavé (halfway)' },
  pave2: { label: 'Double-row pavé' },
  channel: { label: 'Channel set' },
  eternity: { label: 'Pavé all the way round' },
};

/**
 * spec = {
 *   innerR, band: { width, thickness, profile, shank, accent, accentScale, milgrain },
 *   head: { style, prongs, prongStyle, prongR, clearance, basket, haloStone, haloGap, milgrain },
 *   center: { gem, scale, yaw },
 *   side: { gem, scale } (three/five stone), side2: { gem, scale } (five stone outer pair),
 *   second: { gem, scale, yaw } (toi et moi),
 *   wedding: null | { style, width, thickness, profile, contour },
 *   mats: { band, head, wedding }, gemMat(gem, role) → material
 * }
 */
export function buildRing(spec) {
  const group = new THREE.Group();
  group.name = 'ring';
  const Ri = spec.innerR;
  const band = spec.band, head = spec.head;
  const style = head.style;
  const bandParts = [], headParts = [], weddingParts = [];
  const beadsHead = [], beadsBand = [], beadsWedding = [];
  const accentStones = []; // { gem, matrix }
  const gems = [];

  const centre = spec.center;
  const cGem = centre.gem, cS = centre.scale;
  const W = band.width;
  const T = band.thickness;
  const tensionT = Math.max(T, 2.4);

  // --- stone placement -----------------------------------------------------
  const clearance = head.clearance;
  const bandTop0 = Ri + (style === 'tension' ? tensionT : T * (band.shank === 'tapered' ? 0.9 : 1));
  const stones = []; // { gem, s, matrix, sf, role, prongs }

  const placeStone = (gem, s, yaw, phi, zOff, girdleR, role, prongCount) => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -phi);
    const qq = tilt.clone().multiply(q);
    const p = new THREE.Vector3(girdleR * Math.sin(phi), girdleR * Math.cos(phi), zOff);
    m.compose(p, qq, new THREE.Vector3(1, 1, 1));
    const sf = new StoneFrame(gem, s, m);
    stones.push({ gem, s, matrix: m, sf, role, prongCount, yaw, phi });
    return sf;
  };

  const gemHalf = (gem, s, yaw) => {
    // half extents across the finger (X) and along it (Z) after yaw
    const w = (gem.width * s) / 2, l = (gem.length * s) / 2;
    const c = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
    return { x: w * c + l * sn, z: w * sn + l * c };
  };

  const cHalf = gemHalf(cGem, cS, centre.yaw);
  let Yg;
  if (style === 'tension') Yg = Ri + tensionT * 0.6;
  else Yg = bandTop0 + clearance + cGem.pavilionDepth * cS + (cGem.girdle / 2) * cS;

  if (style === 'toiEtMoi') {
    const sec = spec.second;
    const bHalf = gemHalf(sec.gem, sec.scale, sec.yaw);
    const gap = 0.5;
    const ygA = bandTop0 + clearance + cGem.pavilionDepth * cS + (cGem.girdle / 2) * cS;
    const ygB = bandTop0 + clearance + sec.gem.pavilionDepth * sec.scale + (sec.gem.girdle / 2) * sec.scale;
    const tilt = 0.55;
    const dx = (cHalf.x * Math.cos(tilt) + cHalf.z * Math.sin(tilt) + bHalf.x * Math.cos(tilt) + bHalf.z * Math.sin(tilt)) / 2 + gap / 2;
    const zo = Math.max(cHalf.z, bHalf.z) * 0.35;
    placeStone(cGem, cS, centre.yaw + tilt, -dx / ygA, -zo, ygA, 'center', head.prongs);
    placeStone(sec.gem, sec.scale, sec.yaw - tilt, dx / ygB, zo, ygB, 'center', 'auto');
    Yg = Math.max(ygA, ygB);
  } else {
    placeStone(cGem, cS, centre.yaw, 0, 0, Yg, 'center', head.prongs);
  }

  if (style === 'threeStone' || style === 'fiveStone') {
    const sd = spec.side;
    const sHalf = gemHalf(sd.gem, sd.scale, Math.PI / 2);
    const ygS = bandTop0 + Math.min(clearance, 0.6) + sd.gem.pavilionDepth * sd.scale + (sd.gem.girdle / 2) * sd.scale;
    const gap = 0.35 + head.prongR;
    const phi1 = (cHalf.x + sHalf.x + gap) / ((Yg + ygS) / 2);
    placeStone(sd.gem, sd.scale, Math.PI / 2, phi1, 0, ygS, 'side', 'auto');
    placeStone(sd.gem, sd.scale, -Math.PI / 2, -phi1, 0, ygS, 'side', 'auto');
    if (style === 'fiveStone' && spec.side2) {
      const s2 = spec.side2;
      const h2 = gemHalf(s2.gem, s2.scale, Math.PI / 2);
      const yg2 = bandTop0 + Math.min(clearance, 0.5) + s2.gem.pavilionDepth * s2.scale + (s2.gem.girdle / 2) * s2.scale;
      const phi2 = phi1 + (sHalf.x + h2.x + gap) / ((ygS + yg2) / 2);
      placeStone(s2.gem, s2.scale, Math.PI / 2, phi2, 0, yg2, 'side', 'auto');
      placeStone(s2.gem, s2.scale, -Math.PI / 2, -phi2, 0, yg2, 'side', 'auto');
    }
  }

  // head footprint (ring X/Z half extents at the top) for pavé start and wedding band clearance
  let headHalfX = 0, headHalfZ = 0;
  for (const st of stones) {
    const h = gemHalf(st.gem, st.s, st.yaw);
    const x = Math.abs(st.matrix.elements[12]) + h.x;
    const z = Math.abs(st.matrix.elements[14]) + h.z;
    headHalfX = Math.max(headHalfX, x + head.prongR);
    headHalfZ = Math.max(headHalfZ, z + head.prongR);
  }

  // --- head metalwork ------------------------------------------------------
  const haloRows = [];
  for (const st of stones) {
    const sf = st.sf;
    const local = []; // geometries in stone frame
    // y of the band top in this stone's frame (directly under it)
    const girdleR = Math.hypot(st.matrix.elements[12], st.matrix.elements[13]);
    const baseY = (style === 'tension' ? Ri + tensionT : bandTop0) - girdleR - 0.25;
    const isCentre = st.role === 'center';
    const r = isCentre ? head.prongR : Math.max(0.45, head.prongR * 0.8);
    const hasHalo = isCentre && (style === 'halo' || style === 'doubleHalo') && st === stones[0];

    if (style === 'tension' && isCentre) {
      // no metal on the stone; the band ends hold it
    } else if (isCentre && (style === 'bezel' || style === 'halfBezel')) {
      local.push(...bezel(sf, style === 'halfBezel', baseY));
    } else {
      const count = st.prongCount === 'auto' ? CUTS[st.gem.cut].prongs.default : st.prongCount;
      const layout = prongLayout(st.gem.cut, count, st.gem);
      const pr = hasHalo ? r * 0.82 : r;
      for (const pp of layout) local.push(...prongGeometry(sf, pp.u, pp.kind, pr, head.prongStyle, baseY, hasHalo));
      // basket rail(s) and seat
      const rails = hasHalo ? [] : head.basket === 'double' ? [0.3, 0.68] : head.basket === 'none' ? [] : [0.45];
      for (const f of rails) {
        const pts = [];
        for (let i = 0; i < 64; i++) { const u = i / 64; pts.push(sf.pav(u, f).addScaledVector(sf.N(u), pr * 0.55 + 0.04)); }
        local.push(tube(pts, () => Math.max(0.28, pr * 0.55), { segments: 96, radial: 10, closed: true }));
      }
      const seat = [];
      for (let i = 0; i < 40; i++) { const u = i / 40; const q = sf.pav(u, 0.9); seat.push(new THREE.Vector3(q.x * 0.6, sf.yCulet - 0.3, q.z * 0.6)); }
      local.push(tube(seat, () => Math.max(0.3, pr * 0.6), { segments: 64, radial: 10, closed: true }));
    }

    if (hasHalo) {
      const rows = style === 'doubleHalo' ? 2 : 1;
      let offset = head.haloGap;
      let y = -0.15;
      for (let row = 0; row < rows; row++) {
        const d = head.haloStone * (row === 1 ? 0.9 : 1);
        const ctr = offset + d / 2;
        haloRows.push(haloRing(sf, ctr, d, y, head.milgrain, local, beadsHead, accentStones, st.matrix, baseY));
        offset = ctr + d / 2 + 0.16;
        y -= 0.22;
      }
    }
    if (isCentre && style === 'hiddenHalo' && st === stones[0]) {
      hiddenHalo(sf, head.haloStone * 0.85, local, beadsHead, accentStones, st.matrix);
    }

    for (const g of local) { g.applyMatrix4(st.matrix); headParts.push(g); }

    // the stone itself
    const mesh = new THREE.Mesh(st.gem.geometry, spec.gemMat(st.gem, st.role));
    const mm = st.matrix.clone().multiply(new THREE.Matrix4().makeScale(st.s, st.s, st.s));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(mm);
    mesh.layers.set(L.GEM);
    mesh.castShadow = true;
    mesh.userData.role = st.role;
    mesh.userData.gem = st.gem;
    gems.push(mesh);
    group.add(mesh);
  }

  // --- band ------------------------------------------------------------------
  const shank = band.shank;
  const profile = band.profile;
  const cathedral = style === 'cathedral';
  // cathedral shoulders climb to the basket rail (pavilion fraction 0.45) and end against it
  const railOut = (1 - 0.45) * cHalf.x + head.prongR * 0.55 + 0.04;
  const headSideAngle = Math.asin(clamp(railOut / (Ri + T), 0.05, 0.95));
  const railY = Yg + (-cGem.girdle / 2 + (cGem.yBottom + cGem.girdle / 2) * 0.45) * cS;
  const rise = Math.max(0, railY - 0.3 - (Ri + T));
  const widthAt = (phi) => {
    const a = Math.abs(((phi + Math.PI) % TAU + TAU) % TAU - Math.PI);
    let w = W;
    if (shank === 'tapered') w = W * (1 - 0.38 * smooth(1.25, 0.12, a));
    if (cathedral) w *= 1 - 0.18 * smooth(1.2, headSideAngle, a);
    return w;
  };
  const thickAt = (phi) => {
    const a = Math.abs(((phi + Math.PI) % TAU + TAU) % TAU - Math.PI);
    let t = style === 'tension' ? tensionT : T;
    if (shank === 'tapered') t *= 1 - 0.1 * smooth(1.25, 0.12, a);
    return t;
  };
  // cathedral: two slim arches each side spring from the top of the shank and
  // sweep up to hold the basket, leaving an open arch under the head
  if (cathedral) {
    const r = clamp(W * 0.21, 0.34, 0.62);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const zBand = sz * (widthAt(headSideAngle + 0.6) / 2 - r * 0.9);
        const zHead = sz * clamp(cHalf.z * 0.42, Math.abs(zBand) * 0.9, cHalf.z * 0.7);
        const onBand = (phi, lift = 0) => { const rho = Ri + T - r * 0.6 + lift; return new THREE.Vector3(sx * rho * Math.sin(phi), rho * Math.cos(phi), zBand); };
        // starts buried in the shank so the arch grows out of it
        const p0 = onBand(headSideAngle + 0.46, -r * 1.3);
        const p1 = onBand(headSideAngle + 0.3, -r * 0.1);
        const p2 = onBand(headSideAngle + 0.1, rise * 0.5);
        p2.z = (zBand + zHead) / 2;
        const p3 = new THREE.Vector3(sx * railOut * 1.02, railY - rise * 0.12, zHead * 0.98);
        const p4 = new THREE.Vector3(sx * railOut * 0.92, railY + 0.05, zHead);
        bandParts.push(tube([p0, p1, p2, p3, p4], (t) => r * (1 - 0.25 * t), { segments: 40, radial: 12, capEnd: true }));
      }
    }
  }
  const sectionAt = (phi, w = widthAt(phi), t = thickAt(phi), zc = 0) => bandSection(profile, w, t).map(([a, z]) => [Ri + a, z + zc]);

  const rows = []; // accent rows: { phiFn ranges, z(φ), top(φ), width(φ) }
  if (style === 'tension') {
    const phiGap = Math.asin(clamp((cHalf.x - 0.3) / Yg, 0.05, 0.9));
    const tw = Math.max(W, Math.min(cHalf.z * 2 * 0.75, 5));
    const tSection = (phi) => {
      const a = Math.abs(((phi + Math.PI) % TAU + TAU) % TAU - Math.PI);
      const w = W + (tw - W) * smooth(1.4, phiGap, a);
      return bandSection(profile, w, tensionT).map(([aa, z]) => [Ri + aa, z]);
    };
    bandParts.push(sweepAroundAxis(phiGap, TAU - phiGap, 220, tSection, { caps: true }));
    rows.push({ z: () => 0, top: (phi) => Ri + profileHeights(profile, W, tensionT).out(0), width: () => W, min: phiGap + 0.25 });
  } else if (shank === 'split') {
    // the band narrows into two arms that part around the head and close up again under the stone,
    // so the stem always lands on metal
    const phiS = 0.8;
    const ws = (phi) => widthAt(phi) * 0.52;
    const sep = Math.max(W * 0.45, Math.min(headHalfZ - ws(0) / 2, W * 1.4));
    const z0 = ws(0) * 0.45; // arms overlap a little at the neck under the stem
    const cOf = (phi) => { const a = Math.abs(phi); return smooth(phiS, 0.3, a) * (z0 + (sep * 1.1 - z0) * smooth(0.02, 0.45, a)); };
    // the full band tapers to the arm section exactly where the arms start, so there is no step at the fork
    const taper = (phi) => smooth(phiS + 0.35, phiS, absAngle(phi));
    const wMain = (phi) => widthAt(phi) * (1 - 0.48 * taper(phi));
    const tMain = (phi) => thickAt(phi) * (1 - 0.04 * taper(phi));
    bandParts.push(sweepAroundAxis(phiS, TAU - phiS, 200, (phi) => sectionAt(phi, wMain(phi), tMain(phi)), { caps: true }));
    for (const sgn of [-1, 1]) {
      bandParts.push(sweepAroundAxis(-phiS, phiS, 120, (phi) => sectionAt(phi, ws(phi), thickAt(phi) * 0.96, sgn * cOf(phi)), { caps: true }));
      rows.push({ z: (phi) => (Math.abs(phi) < phiS ? sgn * cOf(phi) : 0), top: (phi) => Ri + profileHeights(profile, ws(phi), thickAt(phi) * 0.96).out(0), width: (phi) => ws(phi), max: phiS, splitRow: true });
    }
    rows.push({ z: () => 0, top: (phi) => Ri + profileHeights(profile, wMain(phi), tMain(phi)).out(0), width: wMain, min: phiS + 0.22 });
  } else if (shank === 'twist') {
    const rs = W * 0.27;
    const k = 14;
    for (let j = 0; j < 2; j++) {
      const ph = j * Math.PI;
      const zc = (phi) => (W / 2 - rs) * Math.cos(k * phi + ph);
      const rc = (phi) => Ri + rs * 1.02 + rs * 0.42 * (1 + Math.sin(k * phi + ph)) * (T / (2.2 * rs));
      bandParts.push(sweepAroundAxis(-Math.PI, Math.PI, 420, (phi) => circleSection(rs).map(([a, b]) => [rc(phi) + a, zc(phi) + b]), { loop: true }));
      if (j === 0) rows.push({ z: zc, top: (phi) => rc(phi) + rs, width: () => rs * 1.5 });
    }
  } else {
    bandParts.push(sweepAroundAxis(-Math.PI, Math.PI, 240, (phi) => sectionAt(phi), { loop: true }));
    rows.push({ z: () => 0, top: (phi) => Ri + profileHeights(profile, widthAt(phi), thickAt(phi)).out(0), width: widthAt });
  }

  // band milgrain
  if (band.milgrain && (shank === 'plain' || shank === 'tapered') && style !== 'tension') {
    const step = 0.27;
    const rr = Math.min(0.12, T * 0.08);
    for (let phi = -Math.PI; phi < Math.PI; phi += step / (Ri + T)) {
      const a = Math.abs(phi);
      if (a < headSideAngle * (cathedral ? 1.4 : 0.6)) continue;
      const w = widthAt(phi), t = thickAt(phi);
      const { out } = profileHeights(profile, w, t);
      for (const sgn of [-1, 1]) {
        const z = sgn * (w / 2 - rr * 1.6);
        const rho = Ri + out(z) - rr * 0.2;
        beadsBand.push({ p: new THREE.Vector3(rho * Math.sin(phi), rho * Math.cos(phi), z), r: rr });
      }
    }
  }

  // pavé / channel accents
  if (band.accent !== 'none' && style !== 'tension') {
    const full = band.accent === 'eternity';
    const startPhi = Math.asin(clamp((headHalfX + 0.25) / (Ri + T + 1), 0.05, 0.95)) + 0.03;
    const endPhi = full ? Math.PI : Math.min(Math.PI, 1.95);
    for (const row of rows) {
      const lo = Math.max(startPhi, row.min || 0);
      const hi = Math.min(endPhi, row.max || Math.PI);
      if (hi <= lo) continue;
      // stone size from the narrowest width in range
      let wMin = Infinity;
      for (let i = 0; i <= 20; i++) wMin = Math.min(wMin, row.width(lo + ((hi - lo) * i) / 20));
      const doubleRow = band.accent === 'pave2' && !row.splitRow;
      const d = clamp((doubleRow ? wMin * 0.42 : wMin * 0.7) * band.accentScale, 0.7, 2.4);
      const zRows = doubleRow ? [-d * 0.55, d * 0.55] : [0];
      const dPhi = (d * 1.1) / row.top(lo);
      for (const side of [-1, 1]) {
        // eternity: the left side runs to the bottom of the ring, the right side stops one stone short
        const last = full ? (side < 0 ? Math.PI : Math.PI - dPhi * 0.9) : hi - dPhi / 2;
        for (const zr of zRows) {
          for (let phi = lo + dPhi / 2; phi <= last; phi += dPhi) {
            const ph = side * phi;
            const z = row.z(ph) + zr;
            const sink = band.accent === 'channel' ? d * 0.12 : d * 0.04;
            const rg = row.top(ph) - sink;
            accentStones.push({
              gem: 'round',
              matrix: new THREE.Matrix4().compose(
                new THREE.Vector3(rg * Math.sin(ph), rg * Math.cos(ph), z),
                new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -ph),
                new THREE.Vector3(d, d, d)
              ),
            });
            if (band.accent !== 'channel') {
              const php = ph + side * dPhi * 0.5;
              const rt = row.top(php) + 0.02;
              for (const bz of [-d * 0.5, d * 0.5]) {
                const zz = row.z(php) + zr + bz * 0.92;
                beadsBand.push({ p: new THREE.Vector3(rt * Math.sin(php), rt * Math.cos(php), zz), r: d * 0.19 });
              }
            }
          }
        }
        if (band.accent === 'channel') {
          // metal walls either side of the stones
          for (const sgn of [-1, 1]) {
            const wall = (phi) => {
              const top = row.top(phi);
              const z = row.z(phi) + sgn * (d / 2 + 0.13);
              return [[top - 0.35, z - 0.13], [top + d * 0.17, z - 0.13], [top + d * 0.2, z], [top + d * 0.17, z + 0.13], [top - 0.35, z + 0.13]];
            };
            const a0 = lo, a1 = full ? Math.PI : hi;
            bandParts.push(sweepAroundAxis(side > 0 ? a0 : -a1, side > 0 ? a1 : -a0, 80, wall, { caps: true }));
          }
        }
      }
    }
  }

  // --- wedding band ----------------------------------------------------------
  let weddingInfo = null;
  if (spec.wedding) {
    const wd = spec.wedding;
    const ww = wd.width, wt = wd.thickness;
    const baseZ = W / 2 + ww / 2 + 0.12;
    const overhang = Math.max(0, headHalfZ + 0.15 + ww / 2 - baseZ);
    const sigma = (headHalfX + 1.5) / (Ri + wt);
    const zAt = (phi) => {
      const a = Math.abs(((phi + Math.PI) % TAU + TAU) % TAU - Math.PI);
      if (wd.style === 'contour') return baseZ + overhang * Math.exp(-((a / sigma) ** 2) * 1.6);
      return baseZ + (style === 'halo' || style === 'doubleHalo' || style === 'bezel' || style === 'toiEtMoi' ? overhang : 0);
    };
    weddingParts.push(sweepAroundAxis(-Math.PI, Math.PI, 260, (phi) => bandSection(wd.profile || 'domed', ww, wt).map(([a, z]) => [Ri + a, z + zAt(phi)]), { loop: true }));
    if (wd.style === 'pave' || wd.style === 'eternity') {
      const d = clamp(ww * 0.68, 0.8, 2.2);
      const top = Ri + profileHeights(wd.profile || 'domed', ww, wt).out(0);
      const dPhi = (d * 1.1) / top;
      const lim = wd.style === 'eternity' ? Math.PI : 1.6;
      for (let phi = -lim + dPhi / 2; phi < lim - dPhi * 0.4; phi += dPhi) {
        const rg = top - d * 0.04;
        accentStones.push({ gem: 'round', matrix: new THREE.Matrix4().compose(new THREE.Vector3(rg * Math.sin(phi), rg * Math.cos(phi), zAt(phi)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -phi), new THREE.Vector3(d, d, d)) });
        const php = phi + dPhi / 2;
        for (const bz of [-d * 0.46, d * 0.46]) beadsWedding.push({ p: new THREE.Vector3((top + 0.02) * Math.sin(php), (top + 0.02) * Math.cos(php), zAt(php) + bz), r: d * 0.19 });
      }
    }
    weddingInfo = { z: baseZ, width: ww, thickness: wt };
  }

  // --- meshes ------------------------------------------------------------------
  const addMetal = (parts, mat, name) => {
    if (!parts.length) return null;
    const geo = mergeGeometries(parts.map(normaliseAttributes));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.layers.set(L.METAL);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  addMetal(bandParts, spec.mats.band, 'band');
  addMetal(headParts, spec.mats.head, 'head');
  addMetal(weddingParts, spec.mats.wedding, 'wedding');
  const addBeads = (list, mat, name) => {
    if (!list.length) return;
    const geo = new THREE.SphereGeometry(1, 12, 8);
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4();
    list.forEach((b, i) => { m.makeScale(b.r, b.r, b.r).setPosition(b.p); im.setMatrixAt(i, m); });
    im.name = name;
    im.layers.set(L.METAL);
    im.castShadow = true;
    group.add(im);
  };
  addBeads(beadsHead, spec.mats.head, 'beads-head');
  addBeads(beadsBand, spec.mats.band, 'beads-band');
  addBeads(beadsWedding, spec.mats.wedding, 'beads-wedding');

  if (accentStones.length) {
    const rg = buildGem('round', 1);
    const im = new THREE.InstancedMesh(rg.geometry, spec.gemMat(rg, 'accent'), accentStones.length);
    accentStones.forEach((a, i) => im.setMatrixAt(i, a.matrix));
    im.layers.set(L.GEM);
    im.castShadow = true;
    im.userData.role = 'accent';
    im.userData.gem = rg;
    im.frustumCulled = false;
    gems.push(im);
    group.add(im);
  }

  // stone centre (for reflection capture) and stats
  const main = stones[0];
  const capture = new THREE.Vector3();
  for (const st of stones.filter((s) => s.role === 'center')) {
    const c = new THREE.Vector3(0, ((st.gem.yTop + st.gem.yBottom) / 2) * st.s, 0).applyMatrix4(st.matrix);
    capture.add(c);
  }
  capture.divideScalar(stones.filter((s) => s.role === 'center').length);
  const tableTop = new THREE.Vector3(0, main.gem.yTop * main.s, 0).applyMatrix4(main.matrix).y;
  return {
    group,
    gems,
    capturePoint: capture,
    headTop: tableTop,
    stats: {
      stoneWidthMm: main.gem.width * main.s,
      stoneLengthMm: main.gem.length * main.s,
      depthMm: main.gem.depth * main.s,
      heightAboveFinger: tableTop - Ri,
      headHalfX,
      headHalfZ,
      accentCount: accentStones.length,
      sideCount: stones.filter((s) => s.role === 'side').length,
    },
    occluders: {
      innerR: Ri,
      bandHalfWidth: W / 2,
      bandOuter: Ri + T,
      head: new THREE.Vector3(0, Yg - cGem.pavilionDepth * cS * 0.5, 0),
      headRadius: Math.max(cHalf.x, cHalf.z) * 0.9,
      wedding: weddingInfo,
    },
  };
}

function normaliseAttributes(g) {
  let geo = g.index ? g : g;
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(idx);
  }
  return geo;
}

// --- bezel --------------------------------------------------------------------

function bezel(sf, half, baseY) {
  const n = 160;
  const lip = 0.24;
  const wall = 0.62;
  const lipY = sf.crownY(lip) + 0.06;
  const frames = [];
  const centre = sf.centre();
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const p = sf.P(u), nn = sf.N(u);
    frames.push({ u, p, n: nn, c: new THREE.Vector3(centre.x, 0, centre.z), up: new THREE.Vector3(0, 1, 0) });
  }
  const cupBottom = Math.max(baseY + 0.2, sf.yCulet - 0.45);
  // the cup keeps tapering into a solid foot that sits on the band, whatever gap is dialled in under the stone
  const profile = [
    [1, -lip, lipY],
    [1, -lip * 0.3, lipY + 0.05],
    [1, wall * 0.75, lipY + 0.02],
    [1, wall, lipY - 0.12],
    [1, wall, sf.yGb - sf.hp * 0.32],
    [0.62, wall * 0.8, sf.yCulet + sf.hp * 0.15],
    [0.4, wall * 0.5, cupBottom],
    [0.36, wall * 0.46, cupBottom - (cupBottom - baseY) * 0.55],
    [0.4, wall * 0.54, baseY],
    [0, 0, baseY],
    [0, 0, cupBottom + 0.05],
    [0.35, 0, cupBottom + 0.05],
    [0.92, -0.05, sf.yGb - sf.hp * 0.1],
    [1, -0.04, sf.yGb],
  ];
  const parts = [];
  if (!half) {
    parts.push(sweepFrames(frames, profile, { closed: true }));
  } else {
    // two arcs on the sides across the finger (east and west)
    for (const centreDeg of [0, 180]) {
      const uc = sf.gem.outline.uAtAngle((centreDeg * Math.PI) / 180);
      const span = 0.16;
      const sub = [];
      for (let i = 0; i <= 50; i++) {
        const u = uc - span + (2 * span * i) / 50;
        const p = sf.P(u), nn = sf.N(u);
        sub.push({ p, n: nn, c: new THREE.Vector3(centre.x, 0, centre.z), up: new THREE.Vector3(0, 1, 0) });
      }
      parts.push(sweepFrames(sub, profile, { closed: false, caps: true }));
    }
  }
  if (half) {
    // the open sides still need a seat ring and a post under the stone (a full bezel's foot already covers this)
    const stem = [];
    for (let i = 0; i < 32; i++) { const u = i / 32; const q = sf.pav(u, 0.85); stem.push(new THREE.Vector3(q.x * 0.45, cupBottom - 0.05, q.z * 0.45)); }
    parts.push(tube(stem, () => 0.35, { closed: true, segments: 48, radial: 8 }));
    const post = [new THREE.Vector3(0, cupBottom, 0), new THREE.Vector3(0, (cupBottom + baseY) / 2, 0), new THREE.Vector3(0, baseY, 0)];
    parts.push(tube(post, () => Math.max(0.6, sf.s * 0.1), { segments: 8, radial: 12 }));
  }
  return parts;
}

// --- halos ----------------------------------------------------------------------

function haloRing(sf, offset, d, y, milgrain, local, beads, accentStones, stoneMatrix, baseY) {
  // offset curve sampled densely, then stones placed at equal arc length
  const dense = sf.offsetFrames(offset, 360, y);
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) cum.push(cum[i - 1] + dense[i % dense.length].p.distanceTo(dense[i - 1].p));
  const len = cum[dense.length];
  const count = Math.max(10, Math.floor(len / (d * 1.07)));
  const at = (s) => {
    s = ((s % len) + len) % len;
    let i = 0;
    while (cum[i + 1] < s) i++;
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    const a = dense[i], b = dense[(i + 1) % dense.length];
    return { p: a.p.clone().lerp(b.p, t), n: a.n.clone().lerp(b.n, t).normalize() };
  };
  for (let k = 0; k < count; k++) {
    const { p } = at((len * k) / count);
    const m = new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(d, d, d));
    accentStones.push({ gem: 'round', matrix: stoneMatrix.clone().multiply(m) });
    const mid = at((len * (k + 0.5)) / count);
    for (const sgn of [-1, 1]) {
      const bp = mid.p.clone().addScaledVector(mid.n, sgn * d * 0.4);
      bp.y = y + d * 0.06;
      beads.push({ p: bp.applyMatrix4(stoneMatrix), r: d * 0.17 + 0.04 });
    }
  }
  // frame under the halo stones
  const w = d + 0.34;
  const frames = dense.filter((_, i) => i % 2 === 0).map((f) => ({ p: f.p, n: f.n, c: f.p, up: new THREE.Vector3(0, 1, 0) }));
  const profile = [
    [1, -w / 2, y + 0.03], [1, w / 2, y + 0.03], [1, w / 2, y - d * 0.5],
    [1, w * 0.3, y - d * 0.72], [1, -w * 0.3, y - d * 0.72], [1, -w / 2, y - d * 0.5],
  ];
  local.push(sweepFrames(frames, profile, { closed: true }));
  if (milgrain) {
    const step = 0.26;
    const n = Math.floor(len / step);
    for (let i = 0; i < n; i++) {
      const { p, n: nn } = at((len * i) / n);
      const bp = p.clone().addScaledVector(nn, w / 2 - 0.03);
      bp.y = y + 0.03;
      beads.push({ p: bp.applyMatrix4(stoneMatrix), r: 0.09 });
    }
  }
  // posts from the frame down to the band
  for (const deg of [45, 135, 225, 315]) {
    const u = sf.gem.outline.uAtAngle((deg * Math.PI) / 180);
    const p = sf.P(u).addScaledVector(sf.N(u), offset);
    const pts = [new THREE.Vector3(p.x, y - d * 0.6, p.z), new THREE.Vector3(p.x * 0.7, (y + baseY) / 2, p.z * 0.7), new THREE.Vector3(p.x * 0.35, baseY, p.z * 0.35)];
    local.push(tube(pts, () => 0.34, { segments: 16, radial: 8 }));
  }
  return { count, d };
}

function hiddenHalo(sf, d, local, beads, accentStones, stoneMatrix) {
  const f = 0.22;
  const n = 300;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const q = sf.pav(u, f);
    const nn = sf.N(u);
    frames.push({ p: q.clone().addScaledVector(nn, d * 0.5 + 0.05), n: nn, u });
  }
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + frames[i % n].p.distanceTo(frames[i - 1].p));
  const len = cum[n];
  const count = Math.max(10, Math.floor(len / (d * 1.08)));
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (len * k) / count;
    while (cum[j + 1] < s) j++;
    const fr = frames[j];
    const up = new THREE.Vector3(0, 1, 0).multiplyScalar(0.62).addScaledVector(fr.n, 0.78).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const m = new THREE.Matrix4().compose(fr.p.clone().addScaledVector(up, -d * 0.05), q, new THREE.Vector3(d, d, d));
    accentStones.push({ gem: 'round', matrix: stoneMatrix.clone().multiply(m) });
  }
  const w = d + 0.3;
  const fr2 = frames.filter((_, i) => i % 2 === 0).map((fr) => ({ p: fr.p, n: fr.n, c: fr.p, up: new THREE.Vector3(0, 1, 0) }));
  const profile = [[1, -w * 0.35, -d * 0.25], [1, w * 0.2, -d * 0.45], [1, w * 0.35, -d * 0.75], [1, -w * 0.1, -d * 0.85], [1, -w * 0.45, -d * 0.6]];
  local.push(sweepFrames(fr2, profile, { closed: true }));
}
