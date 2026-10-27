// Nat's Ring Studio: state, controls, photo placement and wiring to the engine.

import { Engine } from './engine.js';
import {
  buildGem, CUTS, CUT_GRADES, GEM_TYPES, VARIETIES, COLOR_GRADES, FANCY_COLORS, FANCY_INTENSITY,
  CLARITY, FLUORESCENCE, scaleForCarat, makeInclusions, outlineSvgPath,
} from './gems.js';
import { buildRing, HEAD_STYLES, SHANKS, ACCENTS, PROFILES } from './ring.js';
import { createGemMaterial, applyOptics } from './gemMaterial.js';
import { METALS, FINISHES, createMetalMaterial } from './metals.js';
import { LIGHT_PRESETS, kelvinToLinear } from './lighting.js';
import { US_SIZES, formatUS, sizeSummary, diameterFromUS } from './sizes.js';
import { Panel, el, getPath, setPath } from './ui.js';
import { detectRingFinger, loadHandLandmarker } from './handDetect.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mode: 'studio',
  stone: {
    type: 'diamond', shape: 'round', carat: 1.0, ratio: 1, orientation: 'ns', flip: false,
    color: 'G', fancy: 'none', fancyIntensity: 'fancy', variety: 'royal', tone: 1,
    clarity: 'VS1', cut: 'excellent', fluorescence: 'none',
    custom: false, table: 57, crownAngle: 34.5, pavilionAngle: 40.8, girdle: 3,
  },
  setting: {
    style: 'solitaire', prongs: 6, prongStyle: 'round', prongSize: 1, basket: 'single', height: 1.0,
    haloSize: 1.2, haloGap: 0.2, milgrain: false,
    sideShape: 'round', sideCarat: 0.3, sideType: 'diamond', secondShape: 'pear', secondCarat: 1.0,
    headMetal: 'match',
  },
  band: { size: 6, width: 2.0, thickness: 1.6, profile: 'domed', shank: 'plain', accent: 'none', accentScale: 1, milgrain: false, metal: 'platinum', finish: 'polished' },
  wedding: { style: 'none', width: 2.0, metal: 'match' },
  light: { preset: 'studio', azimuth: 0, elevation: 0, exposure: 0, kelvin: 5500, bloom: 0.22, glints: 0, shadow: 0.45, quality: 'balanced', rock: false, backdrop: 'light' },
  ui: { simple: true },
  photo: { pitch: 0, roll: 0, slide: 0, together: false, snap: true, match: true, autoLight: true, softness: 0.4, grain: 0.15, photoMix: 0.25, warmth: 0 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
let state = clone(DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem('ers.state') || 'null');
  if (saved && saved.stone) state = deepMerge(clone(DEFAULTS), saved);
} catch (e) { /* storage unavailable */ }
state.mode = 'studio';
state.light.rock = false;

function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k]);
    else if (k in base) base[k] = over[k];
  }
  return base;
}

function persist() {
  try {
    const { mode, ...rest } = state;
    localStorage.setItem('ers.state', JSON.stringify(rest));
  } catch (e) { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
let photo = null; // { canvas, w, h, gray, gw, gh, avgLinear, match }
const placement = { step: 0, a: null, b: null, flip: false, fz: 0, up: null, auto: false };
const stage = $('#stage');
const canvas = $('#view');
let engine;
try {
  engine = new Engine(canvas);
} catch (err) {
  stage.classList.add('no-webgl');
  $('#stage-message').hidden = false;
  $('#stage-message').textContent = 'This browser could not start 3D graphics (WebGL 2). Try a current version of Chrome, Safari, Edge or Firefox.';
  throw err;
}
window.__engine = engine;

const QUALITY = { fast: { samples: 3, bounces: 6 }, balanced: { samples: 5, bounces: 8 }, best: { samples: 8, bounces: 10 } };
const metalCache = new Map();
function metal(key, finish = 'polished') {
  const k = key + '|' + finish;
  if (!metalCache.has(k)) metalCache.set(k, createMetalMaterial(key, finish, engine.envMap ? engine.envMap.texture : null));
  return metalCache.get(k);
}
const gemMatCache = new Map();
function gemMaterial(gem, role) {
  const q = role === 'accent' ? { samples: 3, bounces: 5 } : QUALITY[state.light.quality] || QUALITY.balanced;
  const k = `${gem.cut}|${gem.ratio}|${JSON.stringify(gem.props)}|${role}|${q.samples}|${q.bounces}`;
  if (!gemMatCache.has(k)) gemMatCache.set(k, createGemMaterial(gem, q));
  return gemMatCache.get(k);
}

const isBrilliant = (shape) => CUTS[shape].family === 'brilliant';
const hasRatio = (shape) => CUTS[shape].ratio[0] !== CUTS[shape].ratio[2];

function stoneGem(shape, ratio, st = state.stone) {
  const def = CUTS[shape];
  let props = {};
  if (def.family === 'brilliant') {
    if (st.custom && shape === st.shape) {
      props = { table: st.table / 100, crownAngle: st.crownAngle, pavilionAngle: st.pavilionAngle, girdle: st.girdle / 100 };
    } else {
      const g = CUT_GRADES[st.cut] || CUT_GRADES.excellent;
      props = { table: def.props.table + g.table, crownAngle: def.props.crownAngle + g.crownAngle, pavilionAngle: def.props.pavilionAngle + g.pavilionAngle };
    }
  }
  const r = ratio ? Math.min(def.ratio[2], Math.max(def.ratio[0], ratio)) : def.ratio[1];
  return buildGem(shape, r, props);
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function opticsFor(st, gem, { forceDiamond = false } = {}) {
  const type = forceDiamond ? GEM_TYPES.diamond : GEM_TYPES[st.type];
  let absorb = [0, 0, 0], haze = 0, extra = 0;
  if (type.kind === 'diamond') {
    if (!forceDiamond && st.fancy !== 'none') {
      const f = FANCY_COLORS[st.fancy];
      const k = FANCY_INTENSITY[st.fancyIntensity] || 1;
      absorb = f.opaque ? [6, 6, 6] : f.t.map((v) => (-Math.log(Math.max(v, 1e-4)) / 10) * k);
      haze += f.haze || 0;
      extra += f.inclusions || 0;
    } else {
      const grade = forceDiamond ? 'F' : st.color;
      const k = (COLOR_GRADES.find((g) => g[0] === grade) || COLOR_GRADES[3])[1];
      // cape-series diamonds absorb blue and violet, almost no green
      absorb = [k * 0.04, k * 0.12, k];
    }
  } else if (type.kind === 'colorless') {
    if (type.tint) absorb = type.tint.map((v) => -Math.log(v) / 10);
  } else if (type.kind === 'colored') {
    const list = VARIETIES[type.varieties];
    const v = list[st.variety] || Object.values(list)[0];
    let t = v.t;
    if (v.alt) {
      const m = smoothstep(4800, 3000, state.light.kelvin);
      t = t.map((x, i) => x + (v.alt[i] - x) * m);
    }
    absorb = t.map((x) => (-Math.log(Math.max(x, 1e-4)) / 10) * st.tone);
    haze += type.haze || 0;
  } else if (type.kind === 'opaque') {
    absorb = [8, 8, 8];
  }
  const incl = makeInclusions(gem, forceDiamond ? 'VS2' : st.clarity, extra);
  haze += incl.haze;
  let fluor = [0, 0, 0];
  if (!forceDiamond && type.kind === 'diamond' && st.fancy === 'none') {
    const preset = LIGHT_PRESETS[state.light.preset] || LIGHT_PRESETS.studio;
    const amb = engine.env.ambient;
    const lum = 0.2126 * amb.x + 0.7152 * amb.y + 0.0722 * amb.z;
    const g = FLUORESCENCE[st.fluorescence] * preset.uv * lum * 0.09;
    fluor = [0.32 * g, 0.55 * g, 1.0 * g];
    if (st.fluorescence === 'veryStrong') haze += 0.008 * preset.uv;
  }
  return { ior: type.ior, dispersion: type.dispersion, absorb, haze, inclusions: incl, fluor };
}

let current = null; // last built ring + derived numbers
function rebuild() {
  const st = state.stone, se = state.setting, b = state.band;
  const type = GEM_TYPES[st.type];
  const gem = stoneGem(st.shape, st.ratio);
  const scale = scaleForCarat(gem, st.carat, type.density);
  const yaw = (st.orientation === 'ew' ? Math.PI / 2 : 0) + (st.flip ? Math.PI : 0);
  const innerR = diameterFromUS(b.size) / 2;
  const sideDensity = se.sideType === 'match' ? type.density : GEM_TYPES.diamond.density;
  const sideGem = stoneGem(se.sideShape, null, { ...st, custom: false, cut: 'excellent' });
  const side2Gem = sideGem;
  const secondGem = stoneGem(se.secondShape, null, { ...st, custom: false });
  const prongR = Math.min(0.9, Math.max(0.34, (0.36 + 0.12 * Math.sqrt(st.carat)) * se.prongSize));
  const headMetalKey = se.headMetal === 'match' ? b.metal : se.headMetal;
  const weddingMetalKey = state.wedding.metal === 'match' ? b.metal : state.wedding.metal;
  const mats = { band: metal(b.metal, b.finish), head: metal(headMetalKey, 'polished'), wedding: metal(weddingMetalKey, b.finish) };
  const opticsMain = opticsFor(st, gem);
  const roleOptics = new Map();
  const gemMat = (g, role) => {
    const m = gemMaterial(g, role);
    let o;
    if (role === 'accent') o = opticsFor(st, g, { forceDiamond: true });
    else if (role === 'side') o = se.sideType === 'match' ? opticsFor(st, g) : opticsFor(st, g, { forceDiamond: true });
    else o = g === gem ? opticsMain : opticsFor(st, g);
    applyOptics(m, o);
    roleOptics.set(role, o);
    return m;
  };
  const prongs = se.prongs;
  const built = buildRing({
    innerR,
    band: { width: b.width, thickness: b.thickness, profile: b.profile, shank: b.shank, accent: b.accent, accentScale: b.accentScale, milgrain: b.milgrain },
    head: {
      style: se.style, prongs: CUTS[st.shape].prongs.options.includes(prongs) ? prongs : CUTS[st.shape].prongs.default,
      prongStyle: se.prongStyle, prongR, clearance: se.height, basket: se.basket,
      haloStone: se.haloSize, haloGap: se.haloGap, milgrain: se.milgrain,
    },
    center: { gem, scale, yaw },
    side: { gem: sideGem, scale: scaleForCarat(sideGem, se.sideCarat, sideDensity) },
    side2: { gem: side2Gem, scale: scaleForCarat(side2Gem, se.sideCarat * 0.55, sideDensity) },
    second: { gem: secondGem, scale: scaleForCarat(secondGem, se.secondCarat, type.density), yaw: 0 },
    wedding: state.wedding.style === 'none' ? null : { style: state.wedding.style, width: state.wedding.width, thickness: Math.max(1.3, b.thickness * 0.92), profile: b.profile },
    mats,
    gemMat,
  });
  engine.setRing(built);
  current = { built, gem, scale, innerR, prongR, type };
  updateReport();
}

function applyLighting() {
  const l = state.light;
  engine.setLighting(l.preset, { kelvin: l.kelvin, azimuth: l.azimuth, elevation: l.elevation, photoColor: photo ? photo.avgLinear : null });
  engine.setBackdrop(l.backdrop);
  applyLook();
}

function applyLook() {
  const l = state.light, p = state.photo;
  const inHand = state.mode === 'hand' && photo;
  let tint = [1, 1, 1], expo = Math.pow(2, l.exposure);
  if (inHand && p.match && photo.match) {
    tint = photo.match.tint.slice();
    expo *= photo.match.exposure;
  }
  if (p.warmth && inHand) {
    const w = kelvinToLinear(5600 - p.warmth * 2200), ref = kelvinToLinear(5600);
    tint = tint.map((t, i) => t * (w[i] / ref[i]));
  }
  const lum = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
  tint = tint.map((t) => t / lum);
  engine.setLook({
    exposure: expo, tint,
    softness: inHand ? p.softness : 0, grain: inHand ? p.grain : 0,
    bloom: l.bloom, glints: l.glints, shadow: l.shadow, ao: inHand ? 0.42 : 0.5, saturation: inHand ? 1 : 1.08,
  });
  engine.rock = l.rock && !reduceMotion;
}

// ---------------------------------------------------------------------------
// Change routing
// ---------------------------------------------------------------------------

let pending = { ring: false, light: false, look: false, stoneOptics: false };
let scheduled = false;
function schedule(kind) {
  pending[kind] = true;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const p = pending;
    pending = { ring: false, light: false, look: false };
    if (p.light) applyLighting();
    if (p.ring || p.light) rebuild();
    if (p.look && !p.light) applyLook();
    persist();
    panel.refresh();
  });
}

function onChange(path, value) {
  setPath(state, path, value);
  const [root, key] = path.split('.');
  if (path === 'stone.shape') {
    const def = CUTS[value];
    state.stone.ratio = def.ratio[1];
    if (!def.prongs.options.includes(state.setting.prongs)) state.setting.prongs = def.prongs.default;
    if (value === 'round' || value === 'oldEuropean') state.stone.orientation = 'ns';
    const p = def.props;
    if (def.family === 'brilliant') Object.assign(state.stone, { table: Math.round(p.table * 100), crownAngle: p.crownAngle, pavilionAngle: p.pavilionAngle, girdle: Math.round(p.girdle * 1000) / 10 });
  }
  if (path === 'stone.type') {
    const t = GEM_TYPES[value];
    if (t.kind === 'colored') state.stone.variety = Object.keys(VARIETIES[t.varieties])[0];
  }
  if (path === 'light.preset') {
    state.light.kelvin = LIGHT_PRESETS[value].kelvin;
    if (value !== 'match') state.light.azimuth = 0;
  }
  if (path === 'light.quality') gemMatCache.clear();
  if (path === 'photo.together') { engine.setFingersTogether(value); }
  if (root === 'photo' && ['pitch', 'roll', 'slide'].includes(key)) { updatePlacement(); persist(); return; }
  if (path === 'photo.photoMix') { engine.setPhotoMix(value); }
  if (path === 'photo.autoLight' && value && photo && photo.light) { applyPhotoLight(photo.light); panel.refresh(); return; }
  if (path === 'photo.snap' && value && placement.a && placement.b) { snapHandles(); updatePlacement(); }

  if (root === 'stone' || root === 'setting' || root === 'band' || root === 'wedding') schedule('ring');
  else if (root === 'light') {
    if (['azimuth', 'elevation'].includes(key)) { engine.setLightRotation(state.light.azimuth, state.light.elevation); schedule('look'); }
    else if (['exposure', 'bloom', 'glints', 'shadow', 'rock'].includes(key)) schedule('look');
    else if (key === 'backdrop') { engine.setBackdrop(value); persist(); }
    else schedule('light');
    if (key === 'kelvin' && GEM_TYPES[state.stone.type].varieties === 'alexandrite') schedule('ring');
  } else if (root === 'photo') schedule('look');
}

// ---------------------------------------------------------------------------
// Panel schema
// ---------------------------------------------------------------------------

const fmtMm = (v) => `${v.toFixed(1)} mm`;
const shapeOptions = (filter) => Object.entries(CUTS).filter(([k, d]) => (filter ? filter(k, d) : !d.sideOnly)).map(([k, d]) => [k, d.label, outlineSvgPath(k)]);
const metalSwatch = {
  platinum: '#c9c8c4', whiteGold18: '#e3e2de', whiteGold14: '#e0dfdb', whiteGoldRaw: '#dcd3c2', yellowGold22: '#efc66c', yellowGold18: '#e9c47c', yellowGold14: '#e1c18a',
  yellowGold10: '#d9bd92', champagneGold18: '#e3cba4', roseGold18: '#e9b39f', roseGold14: '#e6ad99', greenGold: '#d6cd8e', palladium: '#d0ccc6', silver: '#ecebe6', titanium: '#a9a49e', tungsten: '#8f8d8a', blackRhodium: '#3a3a3c',
};
const metalOptions = (withMatch) => (withMatch ? [['match', 'Same as band', 'conic-gradient(#e9c47c 0 50%, #e3e2de 0)']] : []).concat(Object.entries(METALS).map(([k, m]) => [k, m.label, metalSwatch[k]]));
const stoneTypeOptions = () => [
  ['__group', 'Diamonds'], ['diamond', GEM_TYPES.diamond.label], ['labDiamond', GEM_TYPES.labDiamond.label],
  ['__group', 'Look-alikes'], ['moissanite', 'Moissanite'], ['cz', 'Cubic zirconia'], ['whiteSapphire', 'White sapphire'],
  ['__group', 'Coloured gems'], ...['sapphire', 'ruby', 'emerald', 'morganite', 'aquamarine', 'alexandrite', 'tanzanite', 'spinel', 'amethyst', 'garnet', 'topaz', 'tourmaline', 'peridot', 'citrine', 'onyx'].map((k) => [k, GEM_TYPES[k].label]),
];
const kind = (s) => GEM_TYPES[s.stone.type].kind;
const colorSwatch = (k) => { const b = Math.min(1, k * 4.2); return `rgb(${255 - 6 * b}, ${252 - 22 * b}, ${246 - 120 * b})`; };

const schema = [
  {
    id: 'stone', label: 'Stone', groups: [
      { title: 'Gem', controls: [
        { type: 'select', path: 'stone.type', label: 'Stone', options: stoneTypeOptions, note: (s) => ({
          labDiamond: 'Lab-grown diamonds are the same material as mined ones, so they look identical here.',
          moissanite: 'Higher dispersion than diamond: more rainbow fire, a little less crisp contrast.',
          cz: 'Denser than diamond, so the same carat weight is a smaller stone.',
          whiteSapphire: 'Lower refractive index: glassier and less sparkly than diamond.',
          onyx: 'Opaque. Only the surface reflects.',
        })[s.stone.type] || '' },
      ] },
      { title: 'Shape', controls: [
        { type: 'shapes', path: 'stone.shape', label: 'Shape', options: () => shapeOptions() },
        { adv: true, type: 'slider', path: 'stone.ratio', label: 'Length to width', when: (s) => hasRatio(s.stone.shape), min: (s) => CUTS[s.stone.shape].ratio[0], max: (s) => CUTS[s.stone.shape].ratio[2], step: 0.01, format: (v) => `${v.toFixed(2)} : 1` },
        { adv: true, type: 'segmented', path: 'stone.orientation', label: 'Direction', when: (s) => !['round', 'oldEuropean'].includes(s.stone.shape), options: [['ns', 'North–south'], ['ew', 'East–west']] },
        { adv: true, type: 'toggle', path: 'stone.flip', label: 'Point the other way', when: (s) => ['pear', 'heart', 'trillion'].includes(s.stone.shape) },
      ] },
      { title: 'Carat weight', controls: [
        { type: 'slider', path: 'stone.carat', label: 'Carat', min: Math.sqrt(0.2), max: Math.sqrt(8), step: 0.001, map: { to: (v) => Math.sqrt(v), from: (x) => Math.round(x * x * 100) / 100 }, format: (v) => `${v.toFixed(2)} ct` },
        { type: 'info', render: () => stoneDims() },
      ] },
      { title: 'Colour', when: (s) => kind(s) === 'diamond', controls: [
        { type: 'select', path: 'stone.fancy', label: 'Colour type', options: [['none', 'Colourless scale (D to Z)'], ...Object.entries(FANCY_COLORS).map(([k, f]) => [k, `Fancy ${f.label.toLowerCase()}`])] },
        { type: 'scale', path: 'stone.color', label: 'Colour grade', when: (s) => s.stone.fancy === 'none', options: COLOR_GRADES.map(([g, k]) => [g, `${g} colour`, colorSwatch(k)]), bands: [['Colourless', 3], ['Near colourless', 4], ['Faint', 3], ['Very light', 3], ['Light', 4]] },
        { type: 'segmented', path: 'stone.fancyIntensity', label: 'Intensity', when: (s) => s.stone.fancy !== 'none' && s.stone.fancy !== 'black', options: [['faint', 'Faint'], ['light', 'Light'], ['fancy', 'Fancy'], ['intense', 'Intense'], ['vivid', 'Vivid'], ['deep', 'Deep']] },
      ] },
      { title: 'Colour', when: (s) => kind(s) === 'colored', controls: [
        { type: 'select', path: 'stone.variety', label: 'Variety', options: (s) => Object.entries(VARIETIES[GEM_TYPES[s.stone.type].varieties]).map(([k, v]) => [k, v.label]), note: (s) => (GEM_TYPES[s.stone.type].varieties === 'alexandrite' ? 'Turns green in daylight and raspberry under warm light. Try the Light tab.' : '') },
        { adv: true, type: 'slider', path: 'stone.tone', label: 'Tone', min: 0.35, max: 2.2, step: 0.01, format: (v) => (v < 0.8 ? 'Lighter' : v > 1.25 ? 'Deeper' : 'Medium') },
      ] },
      { title: 'Clarity', when: (s) => kind(s) !== 'opaque', controls: [
        { type: 'scale', path: 'stone.clarity', label: 'Clarity grade', options: Object.keys(CLARITY).map((k) => [k, k]), bands: [['Flawless', 2], ['Very very slight', 2], ['Very slight', 2], ['Slight', 2], ['Included', 3]],
          note: (s) => (['SI2', 'I1', 'I2', 'I3'].includes(s.stone.clarity) ? 'Inclusions at this grade can show on the hand. Zoom in on the stone to look.' : 'Eye clean: inclusions at this grade need a loupe to see.') },
      ] },
      { adv: true, title: 'Cut', when: (s) => isBrilliant(s.stone.shape), controls: [
        { type: 'select', path: 'stone.cut', label: 'Cut grade', when: (s) => !s.stone.custom, options: Object.entries(CUT_GRADES).map(([k, g]) => [k, g.label]),
          note: (s) => ({ fairShallow: 'A shallow pavilion leaks light: look for a glassy "window" in the middle.', poorDeep: 'A deep pavilion sends light out the sides: the centre goes dark.' })[s.stone.cut] || '' },
        { type: 'toggle', path: 'stone.custom', label: 'Set proportions by hand' },
        { type: 'slider', path: 'stone.table', label: 'Table', when: (s) => s.stone.custom, min: 45, max: 72, step: 0.5, format: (v) => `${v}%` },
        { type: 'slider', path: 'stone.crownAngle', label: 'Crown angle', when: (s) => s.stone.custom, min: 24, max: 42, step: 0.1, format: (v) => `${v.toFixed(1)}°` },
        { type: 'slider', path: 'stone.pavilionAngle', label: 'Pavilion angle', when: (s) => s.stone.custom, min: 37, max: 50, step: 0.05, format: (v) => `${v.toFixed(2)}°` },
        { type: 'slider', path: 'stone.girdle', label: 'Girdle', when: (s) => s.stone.custom, min: 1, max: 7, step: 0.1, format: (v) => `${v.toFixed(1)}%` },
      ] },
      { adv: true, title: 'Fluorescence', when: (s) => kind(s) === 'diamond' && s.stone.fancy === 'none', hint: 'Blue glow under ultraviolet light, which daylight contains. Indoors it barely shows.', controls: [
        { type: 'segmented', path: 'stone.fluorescence', label: 'Strength', options: [['none', 'None'], ['faint', 'Faint'], ['medium', 'Medium'], ['strong', 'Strong'], ['veryStrong', 'Very strong']] },
      ] },
    ],
  },
  {
    id: 'setting', label: 'Setting', groups: [
      { title: 'Style', controls: [
        { type: 'select', path: 'setting.style', label: 'Setting', options: Object.entries(HEAD_STYLES).map(([k, v]) => [k, v.label]) },
      ] },
      { title: 'Prongs', when: (s) => !['bezel', 'halfBezel', 'tension'].includes(s.setting.style), controls: [
        { type: 'segmented', path: 'setting.prongs', label: 'Number', options: (s) => CUTS[s.stone.shape].prongs.options.filter((o) => o !== 'bezel').map((o) => [o, o === 'double' ? '4 double' : String(o)]) },
        { adv: true, type: 'segmented', path: 'setting.prongStyle', label: 'Tips', options: [['round', 'Rounded'], ['claw', 'Claw'], ['double', 'Double claw']], note: 'Points and sharp corners get V-tips automatically.' },
        { adv: true, type: 'slider', path: 'setting.prongSize', label: 'Thickness', min: 0.7, max: 1.5, step: 0.01, format: () => `${(current ? current.prongR * 2 : 1).toFixed(2)} mm` },
        { adv: true, type: 'segmented', path: 'setting.basket', label: 'Basket', options: [['single', 'One rail'], ['double', 'Two rails'], ['none', 'Open']] },
      ] },
      { adv: true, title: 'Height', controls: [
        { type: 'slider', path: 'setting.height', label: 'Gap under the stone', min: 0.15, max: 3.2, step: 0.05, format: (v) => `${v.toFixed(2)} mm`, note: () => (current ? `The table sits ${current.built.stats.heightAboveFinger.toFixed(1)} mm above the finger.` : '') },
      ] },
      { title: 'Halo', when: (s) => ['halo', 'doubleHalo', 'hiddenHalo'].includes(s.setting.style), controls: [
        { type: 'slider', path: 'setting.haloSize', label: 'Halo stones', min: 0.8, max: 2.2, step: 0.05, format: (v) => `${v.toFixed(2)} mm` },
        { adv: true, type: 'slider', path: 'setting.haloGap', label: 'Gap to centre stone', when: (s) => s.setting.style !== 'hiddenHalo', min: 0, max: 0.8, step: 0.02, format: (v) => `${v.toFixed(2)} mm` },
        { adv: true, type: 'toggle', path: 'setting.milgrain', label: 'Milgrain edge', when: (s) => s.setting.style !== 'hiddenHalo' },
      ] },
      { title: 'Side stones', when: (s) => ['threeStone', 'fiveStone'].includes(s.setting.style), controls: [
        { type: 'shapes', path: 'setting.sideShape', label: 'Shape', options: () => shapeOptions((k) => ['round', 'oval', 'pear', 'princess', 'emerald', 'trillion', 'baguette', 'taperedBaguette', 'marquise', 'heart', 'cushion', 'radiant', 'asscher'].includes(k)) },
        { type: 'slider', path: 'setting.sideCarat', label: 'Each side stone', min: Math.sqrt(0.05), max: Math.sqrt(2), step: 0.001, map: { to: (v) => Math.sqrt(v), from: (x) => Math.round(x * x * 100) / 100 }, format: (v) => `${v.toFixed(2)} ct` },
        { adv: true, type: 'segmented', path: 'setting.sideType', label: 'Material', options: [['diamond', 'White diamonds'], ['match', 'Same as centre']] },
      ] },
      { title: 'Second stone', when: (s) => s.setting.style === 'toiEtMoi', controls: [
        { type: 'shapes', path: 'setting.secondShape', label: 'Shape', options: () => shapeOptions() },
        { type: 'slider', path: 'setting.secondCarat', label: 'Carat', min: Math.sqrt(0.2), max: Math.sqrt(5), step: 0.001, map: { to: (v) => Math.sqrt(v), from: (x) => Math.round(x * x * 100) / 100 }, format: (v) => `${v.toFixed(2)} ct` },
      ] },
      { adv: true, title: 'Head metal', hint: 'White prongs keep a colourless diamond looking white in a yellow or rose gold ring.', controls: [
        { type: 'swatches', path: 'setting.headMetal', label: 'Prongs and head', options: () => metalOptions(true) },
      ] },
    ],
  },
  {
    id: 'band', label: 'Band', groups: [
      { title: 'Ring size', hint: 'The inside diameter of the ring. On a photo it sets the scale of everything else.', controls: [
        { type: 'select', path: 'band.size', label: 'US / Canada size', options: US_SIZES.map((s) => [s, `${formatUS(s)} (${diameterFromUS(s).toFixed(1)} mm)`]) },
        { type: 'info', render: (s) => { const z = sizeSummary(s.band.size); return [kv('UK / AU', z.uk), kv('EU', String(z.eu)), kv('Japan', String(z.jp)), kv('Inside', `${z.diameter.toFixed(2)} mm`)]; } },
      ] },
      { title: 'Shape', controls: [
        { adv: true, type: 'segmented', path: 'band.profile', label: 'Profile', options: Object.entries(PROFILES).map(([k, v]) => [k, v.label.replace(' (court)', '')]) },
        { adv: true, type: 'segmented', path: 'band.shank', label: 'Shank', options: Object.entries(SHANKS).map(([k, v]) => [k, v.label.replace(' shank', '')]) },
        { type: 'slider', path: 'band.width', label: 'Width', min: 1.2, max: 8, step: 0.1, format: fmtMm },
        { adv: true, type: 'slider', path: 'band.thickness', label: 'Thickness', min: 1.0, max: 3.0, step: 0.05, format: fmtMm },
      ] },
      { title: 'Stones on the band', controls: [
        { type: 'segmented', path: 'band.accent', label: 'Style', options: Object.entries(ACCENTS).map(([k, v]) => [k, v.label.replace(' (halfway)', '').replace(' all the way round', ' eternity')]) },
        { adv: true, type: 'slider', path: 'band.accentScale', label: 'Stone size', when: (s) => s.band.accent !== 'none', min: 0.7, max: 1.3, step: 0.01, format: () => (current && current.built.stats.accentCount ? `${current.built.stats.accentCount} stones` : '') },
        { adv: true, type: 'toggle', path: 'band.milgrain', label: 'Milgrain edges', when: (s) => ['plain', 'tapered'].includes(s.band.shank) },
      ] },
      { title: 'Metal', controls: [
        { type: 'swatches', path: 'band.metal', label: 'Band metal', options: () => metalOptions(false) },
        { adv: true, type: 'segmented', path: 'band.finish', label: 'Finish', options: Object.entries(FINISHES).map(([k, f]) => [k, f.label.replace(' (brushed)', '').replace(' (sandblasted)', '')]) },
      ] },
      { title: 'Wedding band', controls: [
        { type: 'segmented', path: 'wedding.style', label: 'Stack with', options: [['none', 'None'], ['plain', 'Plain'], ['pave', 'Pavé'], ['eternity', 'Eternity'], ['contour', 'Curved']] },
        { adv: true, type: 'slider', path: 'wedding.width', label: 'Width', when: (s) => s.wedding.style !== 'none', min: 1.2, max: 6, step: 0.1, format: fmtMm },
        { adv: true, type: 'swatches', path: 'wedding.metal', label: 'Metal', when: (s) => s.wedding.style !== 'none', options: () => metalOptions(true) },
      ] },
    ],
  },
  {
    id: 'light', label: 'Light', groups: [
      { title: 'Lighting', controls: [
        { type: 'select', path: 'light.preset', label: 'Lighting scene', options: Object.entries(LIGHT_PRESETS).map(([k, p]) => [k, p.label]) },
        { adv: true, type: 'slider', path: 'light.azimuth', label: 'Light direction', min: -180, max: 180, step: 1, format: (v) => (v === 0 ? 'As set' : `${v > 0 ? 'Turned right' : 'Turned left'} ${Math.abs(v)}°`) },
        { adv: true, type: 'slider', path: 'light.elevation', label: 'Light height', min: -45, max: 60, step: 1, format: (v) => (v === 0 ? 'As set' : `${v > 0 ? 'Higher' : 'Lower'} ${Math.abs(v)}°`) },
        { adv: true, type: 'slider', path: 'light.kelvin', label: 'Light colour', min: 1800, max: 9500, step: 50, format: (v) => `${v} K${v < 3200 ? ', warm' : v > 6500 ? ', cool' : ''}` },
        { adv: true, type: 'slider', path: 'light.exposure', label: 'Brightness', min: -2, max: 2, step: 0.05, format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV` },
      ] },
      { adv: true, title: 'Camera look', controls: [
        { type: 'slider', path: 'light.bloom', label: 'Highlight glow', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
        { type: 'slider', path: 'light.glints', label: 'Star glints', min: 0, max: 1, step: 0.01, format: (v) => (v ? `${Math.round(v * 100)}%` : 'Off') },
        { type: 'slider', path: 'light.shadow', label: 'Shadow', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
        { type: 'toggle', path: 'light.rock', label: 'Rock the ring gently to see it sparkle' },
        { type: 'segmented', path: 'light.backdrop', label: 'Ring view backdrop', options: [['light', 'Light'], ['dark', 'Dark']] },
        { type: 'segmented', path: 'light.quality', label: 'Render quality', options: [['fast', 'Fast'], ['balanced', 'Balanced'], ['best', 'Best']], note: 'Best traces 8 wavelengths per pixel for smoother fire. Saved images always use at least Balanced.' },
      ] },
    ],
  },
  {
    id: 'photo', label: 'Photo', groups: [
      { title: 'Hand photo', controls: [
        { type: 'buttons', items: [['Add hand photo', () => fileInput.click(), 'primary'], ['Find the finger again', () => { startPlacement(); autoPlace(); }, 'ghost', () => !photo], ['Place it by hand', () => startPlacement(), 'ghost', () => !photo]] },
        { type: 'info', render: () => photoTips() },
      ] },
      { adv: true, title: 'Fit to the finger', when: (s) => !!photo && placement.step === 2, controls: [
        { type: 'slider', path: 'photo.pitch', label: 'Finger tilt', min: -60, max: 60, step: 1, format: (v) => (v === 0 ? (placement.auto ? 'As detected' : 'Flat to the camera') : v > 0 ? `Tip toward camera ${v}°` : `Tip away ${-v}°`) },
        { type: 'slider', path: 'photo.roll', label: 'Finger turn', min: -80, max: 80, step: 1, format: (v) => (v === 0 ? (placement.auto ? 'As detected' : 'Facing the camera') : `${v > 0 ? 'Turned right' : 'Turned left'} ${Math.abs(v)}°`) },
        { type: 'slider', path: 'photo.slide', label: 'Along the finger', min: -8, max: 8, step: 0.1, format: (v) => (v === 0 ? 'Where you tapped' : `${v > 0 ? 'Toward fingertip' : 'Toward hand'} ${Math.abs(v).toFixed(1)} mm`) },
        { type: 'toggle', path: 'photo.together', label: 'Fingers touching (hides the sides of the band)' },
        { type: 'toggle', path: 'photo.snap', label: 'Snap the guides to finger edges' },
      ] },
      { adv: true, title: 'Blend with the photo', when: (s) => !!photo, controls: [
        { type: 'toggle', path: 'photo.match', label: 'Match the photo’s colour and brightness' },
        { type: 'toggle', path: 'photo.autoLight', label: 'Light the ring from the photo’s light direction' },
        { type: 'slider', path: 'photo.warmth', label: 'Warmth', min: -1, max: 1, step: 0.01, format: (v) => (Math.abs(v) < 0.02 ? 'Neutral' : v > 0 ? `Warmer ${Math.round(v * 100)}` : `Cooler ${Math.round(-v * 100)}`) },
        { type: 'slider', path: 'photo.softness', label: 'Softness', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)} px` },
        { type: 'slider', path: 'photo.grain', label: 'Grain', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
        { type: 'slider', path: 'photo.photoMix', label: 'Photo colours in reflections', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
      ] },
    ],
  },
];

function kv(k, v) { return el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })); }

function stoneDims() {
  if (!current) return [];
  const { gem, scale } = current;
  const w = gem.width * scale, l = gem.length * scale, d = gem.depth * scale;
  const dims = Math.abs(w - l) < 0.05 ? `${w.toFixed(2)} mm` : `${l.toFixed(2)} × ${w.toFixed(2)} mm`;
  return [kv('Face up', dims), kv('Depth', `${d.toFixed(2)} mm (${Math.round((gem.depth / gem.width) * 100)}%)`), kv('Facets', String(gem.facetCount))];
}

function photoTips() {
  return [el('p', { class: 'tips', text: 'Best results: back of the hand toward the camera, fingers flat, soft daylight, phone about 30 cm away. JPG or PNG; HEIC opens in Safari.' })];
}

const panel = new Panel($('#panel-controls'), schema, () => state, onChange);

// Simple shows the choices most people make (shape, carat, colour, setting,
// size, metal, lighting); All options shows every control.
{
  const row = el('div', { class: 'simple-switch segmented', role: 'radiogroup', 'aria-label': 'How many options to show' });
  const opts = [[true, 'Simple'], [false, 'All options']];
  const btns = opts.map(([v, label]) => {
    const b = el('button', { type: 'button', role: 'radio', class: 'seg', text: label });
    b.addEventListener('click', () => { state.ui.simple = v; persist(); sync(); panel.refresh(); });
    row.append(b);
    return [v, b];
  });
  const sync = () => btns.forEach(([v, b]) => b.setAttribute('aria-checked', String(state.ui.simple === v)));
  sync();
  $('#panel-controls').before(row);
}
try { const t = localStorage.getItem('ers.tab'); if (t) panel.select(t); } catch (e) { /* storage unavailable */ }

// ---------------------------------------------------------------------------
// Report strip
// ---------------------------------------------------------------------------

function updateReport() {
  if (!current) return;
  const st = state.stone, b = state.band;
  const { gem, scale, innerR, type } = current;
  const w = gem.width * scale, l = gem.length * scale;
  const dims = Math.abs(w - l) < 0.05 ? `${w.toFixed(1)} mm` : `${l.toFixed(1)} × ${w.toFixed(1)} mm`;
  let colour;
  if (type.kind === 'diamond') colour = st.fancy === 'none' ? `${st.color} colour` : `Fancy ${FANCY_COLORS[st.fancy].label.toLowerCase()}`;
  else if (type.kind === 'colored') colour = VARIETIES[type.varieties][st.variety]?.label || '';
  else colour = type.label;
  const cut = isBrilliant(st.shape) && type.kind !== 'opaque' ? (st.custom ? 'Custom cut' : `${CUT_GRADES[st.cut].label} cut`) : `${CUTS[st.shape].family === 'step' ? 'Step' : 'Rose'} cut`;
  const sz = sizeSummary(b.size);
  const across = (st.orientation === 'ew' ? l : w);
  const cover = Math.round((across / (innerR * 2)) * 100);
  const headMetalKey = state.setting.headMetal === 'match' ? b.metal : state.setting.headMetal;
  const items = [
    ['Stone', `${st.carat.toFixed(2)} ct ${CUTS[st.shape].label.toLowerCase()}`, `${type.kind === 'diamond' ? type.label : type.label} · ${dims}`],
    ['Grade', colour, `${type.kind === 'opaque' ? '' : st.clarity + ' · '}${cut}`],
    ['On the finger', `${cover}% of finger width`, `table ${current.built.stats.heightAboveFinger.toFixed(1)} mm above the finger`],
    ['Ring size', `US ${sz.us} · UK ${sz.uk}`, `EU ${sz.eu} · ${sz.diameter.toFixed(1)} mm inside`],
    ['Metal', METALS[b.metal].label, `${b.width.toFixed(1)} × ${b.thickness.toFixed(1)} mm band${headMetalKey !== b.metal ? ` · ${METALS[headMetalKey].label.toLowerCase()} head` : ''}`],
  ];
  const report = $('#report');
  report.replaceChildren(...items.map(([k, v, sub]) => el('div', { class: 'report-item' }, el('span', { class: 'report-k', text: k }), el('span', { class: 'report-v', text: v }), el('span', { class: 'report-sub', text: sub }))));
}

// ---------------------------------------------------------------------------
// Stage sizing and modes
// ---------------------------------------------------------------------------

const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const guides = $('#guides');
const hint = $('#hint');
const emptyHand = $('#empty-hand');

function layoutStage() {
  const r = stage.getBoundingClientRect();
  let w = r.width, h = r.height;
  if (state.mode === 'hand' && photo) {
    const a = photo.w / photo.h;
    if (w / h > a) w = h * a; else h = w / a;
  }
  w = Math.floor(w); h = Math.floor(h);
  engine.resize(w, h);
  canvas.style.left = `${Math.round((r.width - w) / 2)}px`;
  canvas.style.top = `${Math.round((r.height - h) / 2)}px`;
  guides.setAttribute('width', w);
  guides.setAttribute('height', h);
  guides.style.left = canvas.style.left;
  guides.style.top = canvas.style.top;
  drawGuides();
}
new ResizeObserver(() => layoutStage()).observe(stage);

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  engine.setMode(mode);
  stage.dataset.mode = mode;
  emptyHand.hidden = !(mode === 'hand' && !photo);
  canvas.hidden = mode === 'hand' && !photo;
  stageTools.hidden = !(mode === 'hand' && photo);
  layoutStage();
  updateHint();
  applyLighting();
  rebuild();
  panel.refresh();
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

// ---------------------------------------------------------------------------
// Photo loading
// ---------------------------------------------------------------------------

const fileInput = $('#file');
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadPhoto(fileInput.files[0]); fileInput.value = ''; });
$('#add-photo').addEventListener('click', () => fileInput.click());
$('#empty-add').addEventListener('click', () => fileInput.click());

stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragging'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) loadPhoto(f);
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) loadPhoto(f);
});

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  }
}

const HEIC_HELP = 'This is an iPhone HEIC photo, which this browser can’t open. Open the site in Safari, or on the iPhone choose Settings → Camera → Formats → Most Compatible and retake it, or send it to yourself as a JPEG.';
const isHeic = (file) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');

async function loadPhoto(file) {
  let src;
  try { src = await decode(file); } catch (e) {
    toast(isHeic(file) ? HEIC_HELP : 'That file could not be opened. Try a JPG or PNG.');
    return;
  }
  const iw = src.width || src.naturalWidth, ih = src.height || src.naturalHeight;
  const sc = Math.min(1, 2048 / Math.max(iw, ih));
  const w = Math.round(iw * sc), h = Math.round(ih * sc);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  // small copy for reflections and colour statistics
  const small = document.createElement('canvas');
  small.width = 96; small.height = Math.max(1, Math.round((96 * h) / w));
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.filter = 'blur(2px)';
  sctx.drawImage(c, 0, 0, small.width, small.height);
  // grey copy for edge snapping
  const gs = Math.min(1, 1200 / Math.max(w, h));
  const gw = Math.round(w * gs), gh = Math.round(h * gs);
  const g = document.createElement('canvas');
  g.width = gw; g.height = gh;
  const gctx = g.getContext('2d', { willReadFrequently: true });
  gctx.drawImage(c, 0, 0, gw, gh);
  const gd = gctx.getImageData(0, 0, gw, gh).data;
  const gray = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) gray[i] = 0.2126 * gd[i * 4] + 0.7152 * gd[i * 4 + 1] + 0.0722 * gd[i * 4 + 2];
  const sd = sctx.getImageData(0, 0, small.width, small.height).data;
  const acc = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < sd.length; i += 4) {
    const r = srgbToLinear(sd[i] / 255), gg = srgbToLinear(sd[i + 1] / 255), b = srgbToLinear(sd[i + 2] / 255);
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    if (l < 0.01 || l > 0.95) continue;
    acc[0] += r; acc[1] += gg; acc[2] += b; n++;
  }
  const avgLinear = n ? acc.map((v) => v / n) : [0.3, 0.3, 0.3];
  photo = { canvas: c, ctx, w, h, gray, gw, gh, gs, avgLinear, match: null, name: file.name };
  engine.setPhoto(c, w, h, small);
  engine.setPhotoMix(state.photo.photoMix);
  $('#add-photo').textContent = 'Replace photo';
  startPlacement();
  setMode('hand');
  autoPlace();
}

// Find the hand, put the ring on the ring finger and light it like the photo.
// Falls back to tapping the finger edges when no hand is found.
async function autoPlace() {
  if (!photo) return;
  const mine = photo;
  hint.textContent = 'Finding the ring finger…';
  hint.hidden = false;
  let found = null;
  try { found = await detectRingFinger(photo); } catch (e) { console.warn('hand detection failed', e); }
  if (photo !== mine) return; // a newer photo arrived
  if (!found) {
    placement.auto = false;
    updateHint();
    toast('No hand found automatically. Tap the two edges of the ring finger instead.');
    return;
  }
  placement.a = found.a; placement.b = found.b; placement.step = 2;
  placement.fz = found.fz; placement.up = found.up; placement.auto = true;
  placement.flip = false;
  const [dx, dy] = fingertipDir();
  if (dx * found.tip[0] + dy * found.tip[1] < 0) placement.flip = true;
  state.photo.pitch = 0; state.photo.roll = 0; state.photo.slide = 0;
  // fingers pressed against the ring finger hide the band's sides
  const nb = found.neighbours || {};
  state.photo.together = !!(nb.plus || nb.minus);
  engine.setFingersTogether(state.photo.together ? nb : false);
  if (state.photo.autoLight) applyPhotoLight(found.light);
  showGuides = false;
  $('#toggle-guides')?.setAttribute('aria-pressed', 'false');
  updatePlacement();
  updateHint();
  panel.refresh();
  // frame the ring
  const cx = (found.a[0] + found.b[0]) / 2 / photo.w, cy = (found.a[1] + found.b[1]) / 2 / photo.h;
  // close enough that the stone gets real pixels: the finger spans about a fifth of the view
  const z = Math.min(4, Math.max(1, (photo.w * 0.2) / Math.hypot(found.b[0] - found.a[0], found.b[1] - found.a[1])));
  engine.setView(z, cx, cy);
  toast('Ring placed on the ring finger. Turn on Guides to fine-tune.');
}

// light the ring from where the photo's light comes from
function applyPhotoLight(est) {
  if (!est) return;
  const l = state.light;
  l.preset = 'match';
  l.kelvin = LIGHT_PRESETS.match.kelvin;
  if (est.strength < 0.15) {
    // soft, even light: keep the light box overhead and the shadow faint
    l.azimuth = 0; l.elevation = 10; l.shadow = 0.25;
  } else {
    // the stronger the shading across the fingers, the lower and harder the light
    l.azimuth = est.azimuth;
    l.elevation = -Math.round(Math.min(30, (est.strength - 0.15) * 70));
    l.shadow = Math.round(Math.min(0.75, 0.3 + (est.strength - 0.15) * 0.9) * 100) / 100;
  }
  photo.light = est;
  applyLighting();
}

// ---------------------------------------------------------------------------
// Placement: tap two finger edges; drag to refine
// ---------------------------------------------------------------------------

const stageTools = $('#stage-tools');
let showGuides = true;

function startPlacement() {
  if (!photo) { fileInput.click(); return; }
  placement.step = 0; placement.a = null; placement.b = null; placement.flip = false;
  placement.fz = 0; placement.up = null; placement.auto = false;
  engine.ringVisible = false;
  showGuides = true;
  engine.setView(1, 0.5, 0.5);
  // provisional placement so the camera matches the photo before the ring appears
  engine.placement = { cx: photo.w / 2, cy: photo.h / 2, widthPx: photo.w * 0.12, dirX: 0, dirY: -1, pitch: 0, roll: 0, slide: 0 };
  engine.updatePose();
  engine.requestRender();
  if (state.mode !== 'hand') setMode('hand');
  updateHint();
  drawGuides();
  panel.refresh();
}

function fingertipDir() {
  const dx = placement.b[0] - placement.a[0], dy = placement.b[1] - placement.a[1];
  const len = Math.hypot(dx, dy) || 1;
  let px = -dy / len, py = dx / len;
  if (py > 0 || (Math.abs(py) < 1e-6 && px > 0)) { px = -px; py = -py; }
  if (placement.flip) { px = -px; py = -py; }
  return [px, py];
}

function updatePlacement() {
  if (!photo || placement.step < 2) return;
  const [dx, dy] = fingertipDir();
  const a = placement.a, b = placement.b;
  engine.ringVisible = true;
  engine.setPlacement({
    cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, widthPx: Math.hypot(b[0] - a[0], b[1] - a[1]),
    dirX: dx, dirY: dy, pitch: state.photo.pitch, roll: state.photo.roll, slide: state.photo.slide,
    fz: placement.fz, up: placement.up,
  });
  sampleSkin();
  drawGuides();
}

function sampleSkin() {
  const a = placement.a, b = placement.b;
  const [tx, ty] = fingertipDir();
  const wpx = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const acc = [0, 0, 0];
  let n = 0;
  for (let i = 1; i <= 5; i++) {
    for (const off of [-0.9, 0.9]) {
      const t = 0.2 + (0.6 * i) / 6;
      const x = Math.round(a[0] + (b[0] - a[0]) * t + tx * wpx * off);
      const y = Math.round(a[1] + (b[1] - a[1]) * t + ty * wpx * off);
      if (x < 0 || y < 0 || x >= photo.w || y >= photo.h) continue;
      const d = photo.ctx.getImageData(x, y, 1, 1).data;
      acc[0] += srgbToLinear(d[0] / 255); acc[1] += srgbToLinear(d[1] / 255); acc[2] += srgbToLinear(d[2] / 255); n++;
    }
  }
  if (n) engine.setSkinColor(acc.map((v) => v / n));
  // brightness and colour cast around the ring, for "match the photo"
  const R = wpx * 2.5;
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const sx = Math.max(0, Math.round(cx - R)), sy = Math.max(0, Math.round(cy - R));
  const sw = Math.min(photo.w - sx, Math.round(R * 2)), sh = Math.min(photo.h - sy, Math.round(R * 2));
  if (sw > 2 && sh > 2) {
    const d = photo.ctx.getImageData(sx, sy, sw, sh).data;
    let L = 0, m = 0;
    const step = Math.max(4, Math.floor((sw * sh) / 4000)) * 4;
    for (let i = 0; i < d.length; i += step) { L += 0.2126 * srgbToLinear(d[i] / 255) + 0.7152 * srgbToLinear(d[i + 1] / 255) + 0.0722 * srgbToLinear(d[i + 2] / 255); m++; }
    L /= Math.max(1, m);
    const avg = photo.avgLinear;
    const lum = 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2] || 1;
    // a gentle nudge toward the photo: the ring is lit by its own light box, so
    // only the colour cast and a little of the brightness are borrowed
    // a whole-frame average is pulled by skin and backdrops (purple sheets,
    // teal blankets), so only a small, capped share of it reaches the ring
    const cast = avg.map((v) => Math.min(1.08, Math.max(0.93, Math.pow(v / lum, 0.2))));
    photo.match = { tint: cast, exposure: Math.min(1.12, Math.max(0.72, Math.pow(L / 0.3, 0.3))) };
  }
  applyLook();
}

// refine a handle to the strongest edge near it along the finger's width line
function snapHandles() {
  if (!photo || !state.photo.snap) return;
  const { gray, gw, gh, gs } = photo;
  const a = placement.a, b = placement.b;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 8) return;
  const ux = dx / len, uy = dy / len;
  const sample = (x, y) => {
    const gx = Math.min(gw - 1, Math.max(0, Math.round(x * gs))), gy = Math.min(gh - 1, Math.max(0, Math.round(y * gs)));
    return gray[gy * gw + gx];
  };
  const refine = (p, sgn) => {
    const win = Math.max(6, len * 0.14);
    let best = 0, bestT = 0;
    for (let t = -win; t <= win; t += 0.5) {
      const x = p[0] + ux * t, y = p[1] + uy * t;
      const g = Math.abs(sample(x + ux * 2, y + uy * 2) - sample(x - ux * 2, y - uy * 2));
      const w = 1 - (Math.abs(t) / win) * 0.35;
      if (g * w > best) { best = g * w; bestT = t; }
    }
    if (best > 14) { p[0] += ux * bestT; p[1] += uy * bestT; }
    void sgn;
  };
  refine(a, -1);
  refine(b, 1);
}

function updateHint() {
  let text = '';
  if (state.mode === 'hand' && photo) {
    if (placement.step === 0) text = 'Tap one edge of the ring finger, just above the knuckle where a ring sits.';
    else if (placement.step === 1) text = 'Now tap the opposite edge of the same finger.';
  }
  hint.textContent = text;
  hint.hidden = !text;
}

function drawGuides() {
  guides.replaceChildren();
  if (state.mode !== 'hand' || !photo || !showGuides || !engine.photoInfo) return;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const pts = [placement.a, placement.b].filter(Boolean).map((p) => engine.photoToCanvas(p[0], p[1]));
  if (pts.length === 2) {
    guides.append(mk('line', { x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], class: 'guide-line' }));
    const [tx, ty] = fingertipDir();
    const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    const L = Math.max(26, Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) * 0.7);
    const ax = mx + tx * L, ay = my + ty * L;
    const g = mk('g', { class: 'guide-tip', tabindex: '0', role: 'button', 'aria-label': 'Fingertip direction. Activate to flip.' });
    const nx = -ty, ny = tx;
    g.append(mk('line', { x1: mx + tx * 10, y1: my + ty * 10, x2: ax, y2: ay }));
    g.append(mk('polyline', { points: `${ax - tx * 8 + nx * 6},${ay - ty * 8 + ny * 6} ${ax},${ay} ${ax - tx * 8 - nx * 6},${ay - ty * 8 - ny * 6}` }));
    const label = mk('text', { x: ax + tx * 14, y: ay + ty * 14 + 4, 'text-anchor': 'middle' });
    label.textContent = 'fingertip';
    g.append(label);
    g.append(mk('circle', { cx: ax, cy: ay, r: 16, class: 'hit' }));
    const flip = () => { placement.flip = !placement.flip; updatePlacement(); };
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    g.addEventListener('click', flip);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    guides.append(g);
  }
  pts.forEach((p, i) => {
    const h = mk('g', { class: 'handle', tabindex: '0', role: 'button', 'aria-label': `Finger edge ${i + 1}. Arrow keys move it.`, 'data-i': String(i) });
    h.append(mk('circle', { cx: p[0], cy: p[1], r: 14, class: 'hit' }));
    h.append(mk('circle', { cx: p[0], cy: p[1], r: 6, class: 'dot' }));
    h.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      const target = i === 0 ? placement.a : placement.b;
      target[0] += d[0] / engine.view.zoom; target[1] += d[1] / engine.view.zoom;
      updatePlacement();
      guides.querySelector(`[data-i="${i}"]`)?.focus();
    });
    guides.append(h);
  });
}

// pointer handling on the stage
const pointers = new Map();
let drag = null;
const loupe = $('#loupe');
const lctx = loupe.getContext('2d');

function localXY(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

stage.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'hand' || !photo) return;
  if (e.target.closest('.stage-tools, .empty-hand, .guide-tip')) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localXY(e));
  if (pointers.size === 2) { drag = { type: 'pinch', start: [...pointers.values()], zoom: engine.view.zoom, cx: engine.view.cx, cy: engine.view.cy }; return; }
  const [sx, sy] = localXY(e);
  const handle = e.target.closest('.handle');
  if (handle && placement.step === 2) {
    drag = { type: 'handle', i: Number(handle.dataset.i) };
    showLoupe(sx, sy);
    return;
  }
  drag = { type: 'tap', x: sx, y: sy, moved: false, cx: engine.view.cx, cy: engine.view.cy };
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, localXY(e));
  if (!drag) return;
  const [sx, sy] = localXY(e);
  if (drag.type === 'pinch' && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const d0 = Math.hypot(drag.start[0][0] - drag.start[1][0], drag.start[0][1] - drag.start[1][1]);
    const d1 = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
    engine.setView(drag.zoom * (d1 / Math.max(1, d0)), drag.cx, drag.cy);
    drawGuides();
  } else if (drag.type === 'handle') {
    const p = engine.canvasToPhoto(sx, sy);
    const target = drag.i === 0 ? placement.a : placement.b;
    target[0] = Math.min(photo.w, Math.max(0, p[0])); target[1] = Math.min(photo.h, Math.max(0, p[1]));
    updatePlacement();
    showLoupe(sx, sy);
  } else if (drag.type === 'tap') {
    const dx = sx - drag.x, dy = sy - drag.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    if (drag.moved && engine.view.zoom > 1) {
      engine.setView(engine.view.zoom, drag.cx - dx / engine.size.x / engine.view.zoom, drag.cy - dy / engine.size.y / engine.view.zoom);
      drawGuides();
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!drag) return;
  if (drag.type === 'handle') {
    loupe.hidden = true;
    snapHandles();
    updatePlacement();
  } else if (drag.type === 'tap' && !drag.moved) {
    const p = engine.canvasToPhoto(drag.x, drag.y);
    if (placement.step === 0) { placement.a = p; placement.step = 1; }
    else if (placement.step === 1) {
      placement.b = p;
      placement.step = 2;
      snapHandles();
      updatePlacement();
      panel.refresh();
    }
    updateHint();
    drawGuides();
  }
  if (pointers.size === 0) drag = null;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

stage.addEventListener('wheel', (e) => {
  if (state.mode !== 'hand' || !photo) return;
  e.preventDefault();
  const [sx, sy] = localXY(e);
  const before = engine.canvasToPhoto(sx, sy);
  const z = engine.view.zoom * Math.exp(-e.deltaY * 0.0015);
  engine.setView(z, engine.view.cx, engine.view.cy);
  const after = engine.canvasToPhoto(sx, sy);
  engine.setView(engine.view.zoom, engine.view.cx + (before[0] - after[0]) / photo.w, engine.view.cy + (before[1] - after[1]) / photo.h);
  drawGuides();
}, { passive: false });

function showLoupe(sx, sy) {
  const p = engine.canvasToPhoto(sx, sy);
  const S = loupe.width, zoomPx = 4;
  const span = S / zoomPx / Math.max(1, engine.size.x / photo.w * engine.view.zoom);
  lctx.clearRect(0, 0, S, S);
  lctx.imageSmoothingEnabled = true;
  lctx.drawImage(photo.canvas, p[0] - span / 2, p[1] - span / 2, span, span, 0, 0, S, S);
  lctx.strokeStyle = 'rgba(255,255,255,0.9)';
  lctx.lineWidth = 1;
  lctx.beginPath(); lctx.moveTo(S / 2, S / 2 - 12); lctx.lineTo(S / 2, S / 2 + 12); lctx.moveTo(S / 2 - 12, S / 2); lctx.lineTo(S / 2 + 12, S / 2); lctx.stroke();
  const cr = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  loupe.style.left = `${Math.min(sr.width - S / 2 - 8, Math.max(S / 2 + 8, sx + (cr.left - sr.left)))}px`;
  loupe.style.top = `${Math.max(S / 2 + 8, sy + (cr.top - sr.top) - S * 0.9)}px`;
  loupe.hidden = false;
}

$('#zoom-in').addEventListener('click', () => { engine.setView(engine.view.zoom * 1.5, engine.view.cx, engine.view.cy); drawGuides(); });
$('#zoom-out').addEventListener('click', () => { engine.setView(engine.view.zoom / 1.5, engine.view.cx, engine.view.cy); drawGuides(); });
$('#zoom-ring').addEventListener('click', () => {
  if (placement.step < 2) return;
  const cx = (placement.a[0] + placement.b[0]) / 2 / photo.w, cy = (placement.a[1] + placement.b[1]) / 2 / photo.h;
  const z = engine.view.zoom > 1.5 ? 1 : Math.min(8, (photo.w / Math.hypot(placement.b[0] - placement.a[0], placement.b[1] - placement.a[1])) / 3.2);
  engine.setView(z, cx, cy);
  drawGuides();
});
$('#toggle-guides').addEventListener('click', (e) => {
  showGuides = !showGuides;
  e.currentTarget.setAttribute('aria-pressed', String(showGuides));
  drawGuides();
});

// ---------------------------------------------------------------------------
// Save image, saved looks, starting points
// ---------------------------------------------------------------------------

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, Math.max(3200, msg.length * 55));
}

let downloads = null;
if (window.claude && typeof window.claude.use === 'function') {
  window.claude.use('downloads').then((d) => { downloads = d; }).catch(() => {});
}

$('#save').addEventListener('click', async () => {
  const btn = $('#save');
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  const prevQ = state.light.quality;
  try {
    if (prevQ === 'fast') { state.light.quality = 'balanced'; gemMatCache.clear(); rebuild(); }
    const { blob } = await engine.exportImage(2400);
    const name = `ring-${state.stone.carat.toFixed(2)}ct-${state.stone.shape}${state.mode === 'hand' ? '-on-hand' : ''}.png`;
    if (downloads) {
      try { await downloads.save({ filename: name, data: blob }); toast('Saved.'); }
      catch (err) { if (err && err.code !== 'declined') toast('Saving is not available here.'); }
    } else if (window.claude) {
      showPreview(blob);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Saved ' + name);
    }
  } catch (err) {
    console.error(err);
    toast('The image could not be rendered. Try Fast quality or a smaller photo.');
  } finally {
    if (prevQ === 'fast') { state.light.quality = prevQ; gemMatCache.clear(); rebuild(); }
    btn.disabled = false;
    btn.textContent = 'Save image';
  }
});

function showPreview(blob) {
  const dlg = $('#preview');
  const img = dlg.querySelector('img');
  img.src = URL.createObjectURL(blob);
  dlg.hidden = false;
  dlg.querySelector('button').focus();
}
$('#preview button').addEventListener('click', () => { $('#preview').hidden = true; });

const LOOKS_KEY = 'ers.looks';
function loadLooks() { try { return JSON.parse(localStorage.getItem(LOOKS_KEY) || '[]'); } catch (e) { return []; } }
function saveLooks(list) { try { localStorage.setItem(LOOKS_KEY, JSON.stringify(list)); return true; } catch (e) { return false; } }
function lookName() {
  const st = state.stone;
  return `${st.carat.toFixed(2)} ct ${CUTS[st.shape].label.toLowerCase()}, ${HEAD_STYLES[state.setting.style].label.toLowerCase().replace(/ \(.*\)/, '')}, ${METALS[state.band.metal].label.toLowerCase()}`;
}
function renderLooks() {
  const box = $('#looks');
  const list = loadLooks();
  box.replaceChildren(...list.map((l) => {
    const card = el('div', { class: 'look' });
    const open = el('button', { type: 'button', class: 'look-open', title: `Show ${l.name}` }, el('img', { src: l.thumb, alt: '' }), el('span', { text: l.name }));
    open.addEventListener('click', () => { applyPreset(l.state); toast('Look restored.'); });
    const del = el('button', { type: 'button', class: 'look-del', 'aria-label': `Remove ${l.name}`, text: '×' });
    del.addEventListener('click', () => { saveLooks(loadLooks().filter((x) => x.id !== l.id)); renderLooks(); });
    card.append(open, del);
    return card;
  }));
  $('#looks-empty').hidden = list.length > 0;
}
$('#save-look').addEventListener('click', () => {
  const list = loadLooks();
  const { mode, photo: _p, ...rest } = clone(state);
  list.unshift({ id: Date.now(), name: lookName(), thumb: engine.thumbnail(200, ringCentreOnCanvas()), state: rest });
  if (!saveLooks(list.slice(0, 12))) toast('This browser is not keeping saved looks.');
  renderLooks();
});

// where the ring sits on the canvas (hand mode), for thumbnails
function ringCentreOnCanvas() {
  if (state.mode !== 'hand' || !photo || placement.step < 2) return null;
  const c = engine.photoToCanvas((placement.a[0] + placement.b[0]) / 2, (placement.a[1] + placement.b[1]) / 2);
  const span = Math.hypot(placement.b[0] - placement.a[0], placement.b[1] - placement.a[1]) * (engine.size.x / photo.w) * engine.view.zoom;
  return { x: c[0], y: c[1], size: span * 2.4 };
}

function applyPreset(p) {
  const keepPhoto = clone(state.photo);
  const mode = state.mode;
  state = deepMerge(clone(DEFAULTS), p);
  state.photo = deepMerge(state.photo, keepPhoto);
  state.mode = mode;
  gemMatCache.clear();
  applyLighting();
  rebuild();
  persist();
  panel.refresh();
}

const STARTS = [
  ['Classic solitaire', { stone: { shape: 'round', carat: 1.0, color: 'G', clarity: 'VS1', cut: 'excellent' }, setting: { style: 'solitaire', prongs: 6, prongStyle: 'round' }, band: { metal: 'platinum', width: 2.0, profile: 'domed' } }],
  ['Oval, hidden halo', { stone: { shape: 'oval', ratio: 1.4, carat: 1.5, color: 'F', clarity: 'VS2' }, setting: { style: 'hiddenHalo', prongs: 4, prongStyle: 'claw', haloSize: 1.0, headMetal: 'whiteGold18' }, band: { metal: 'yellowGold18', width: 1.8, accent: 'pave' } }],
  ['Cushion halo', { stone: { shape: 'cushion', ratio: 1.05, carat: 1.2, color: 'H', clarity: 'VS2' }, setting: { style: 'halo', prongs: 4, haloSize: 1.15 }, band: { metal: 'whiteGold18', width: 2.0, accent: 'pave', milgrain: false } }],
  ['Emerald three-stone', { stone: { shape: 'emerald', ratio: 1.45, carat: 1.5, color: 'F', clarity: 'VVS2' }, setting: { style: 'threeStone', sideShape: 'taperedBaguette', sideCarat: 0.25, prongs: 4 }, band: { metal: 'platinum', width: 2.2 } }],
  ['Pear and oval toi et moi', { stone: { shape: 'pear', ratio: 1.6, carat: 1.0, color: 'G' }, setting: { style: 'toiEtMoi', secondShape: 'oval', secondCarat: 1.0, prongs: 5 }, band: { metal: 'yellowGold18', width: 1.7 } }],
  ['Bezel, elongated cushion', { stone: { shape: 'elongatedCushion', ratio: 1.35, carat: 1.3, color: 'H' }, setting: { style: 'bezel', height: 0.6 }, band: { metal: 'yellowGold14', width: 2.4, profile: 'flat' } }],
  ['East-west marquise', { stone: { shape: 'marquise', ratio: 2.0, carat: 0.9, orientation: 'ew', color: 'G' }, setting: { style: 'solitaire', prongs: 6, prongStyle: 'claw', height: 0.6 }, band: { metal: 'roseGold18', width: 1.6, profile: 'knife' } }],
  ['Vintage old European', { stone: { shape: 'oldEuropean', carat: 1.1, color: 'J', clarity: 'SI1' }, setting: { style: 'halo', prongs: 6, haloSize: 1.0, milgrain: true, haloGap: 0.15 }, band: { metal: 'yellowGold18', width: 2.0, milgrain: true, shank: 'tapered' } }],
  ['Canary radiant', { stone: { shape: 'radiant', ratio: 1.25, carat: 1.6, fancy: 'yellow', fancyIntensity: 'intense' }, setting: { style: 'halo', prongs: 4, haloSize: 1.1, headMetal: 'yellowGold18' }, band: { metal: 'platinum', width: 2.0, accent: 'pave' } }],
  ['Sapphire and diamond halo', { stone: { type: 'sapphire', variety: 'royal', shape: 'oval', ratio: 1.3, carat: 2.2, clarity: 'VS1' }, setting: { style: 'halo', prongs: 4, haloSize: 1.4, haloGap: 0.1 }, band: { metal: 'whiteGold18', width: 2.2 } }],
  ['Lab emerald cut, 2.5 ct', { stone: { type: 'labDiamond', shape: 'emerald', ratio: 1.5, carat: 2.5, color: 'E', clarity: 'VS1' }, setting: { style: 'solitaire', prongs: 4, prongStyle: 'claw' }, band: { metal: 'platinum', width: 1.8, accent: 'pave' } }],
  ['Moissanite round, 2 ct', { stone: { type: 'moissanite', shape: 'round', carat: 2.0 }, setting: { style: 'cathedral', prongs: 6 }, band: { metal: 'whiteGold14', width: 2.0 } }],
];
const starts = $('#starts');
for (const [label, p] of STARTS) {
  const b = el('button', { type: 'button', class: 'chip', text: label });
  b.addEventListener('click', () => applyPreset(p));
  starts.append(b);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

engine.setFingersTogether(state.photo.together);
applyLighting();
rebuild();
setMode('studio');
renderLooks();
document.body.classList.add('ready');

// Hooks for automated tests (Playwright). Not used by the page itself.
window.__app = {
  get state() { return state; },
  set(path, value) { onChange(path, value); panel.refresh(); },
  preset: applyPreset,
  mode: setMode,
  place(ax, ay, bx, by) {
    if (!photo) return false;
    placement.a = [ax, ay]; placement.b = [bx, by]; placement.step = 2;
    snapHandles(); updatePlacement(); updateHint(); drawGuides(); panel.refresh();
    return [placement.a, placement.b];
  },
  get photo() { return photo ? { w: photo.w, h: photo.h, match: photo.match, light: photo.light } : null; },
  get placement() { return placement; },
  get current() { return current && { stats: current.built.stats, prongR: current.prongR }; },
  loadFile: loadPhoto,
  engine,
};
