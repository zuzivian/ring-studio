// Precious metals as physically based materials.
// Colours are linear-sRGB specular reflectance at normal incidence (F0), from
// measured optical constants (gold, silver, platinum, palladium, titanium) and
// alloy blends for karat golds. Rhodium plating gives white gold its bright,
// slightly cool white.

import * as THREE from 'three';

export const METALS = {
  platinum: { label: 'Platinum', f0: [0.673, 0.637, 0.585], rough: 0.07 },
  whiteGold18: { label: '18k white gold', f0: [0.80, 0.79, 0.77], rough: 0.06, note: 'rhodium plated' },
  whiteGold14: { label: '14k white gold', f0: [0.79, 0.78, 0.76], rough: 0.06, note: 'rhodium plated' },
  whiteGoldRaw: { label: '14k white gold, unplated', f0: [0.76, 0.71, 0.62], rough: 0.08 },
  yellowGold22: { label: '22k yellow gold', f0: [0.99, 0.77, 0.37], rough: 0.06 },
  yellowGold18: { label: '18k yellow gold', f0: [0.96, 0.74, 0.37], rough: 0.06 },
  yellowGold14: { label: '14k yellow gold', f0: [0.92, 0.73, 0.44], rough: 0.06 },
  yellowGold10: { label: '10k yellow gold', f0: [0.88, 0.73, 0.52], rough: 0.07 },
  champagneGold18: { label: '18k champagne gold', f0: [0.93, 0.8, 0.63], rough: 0.06 },
  roseGold18: { label: '18k rose gold', f0: [0.96, 0.67, 0.55], rough: 0.06 },
  roseGold14: { label: '14k rose gold', f0: [0.95, 0.65, 0.56], rough: 0.06 },
  greenGold: { label: '18k green gold', f0: [0.86, 0.81, 0.5], rough: 0.06 },
  palladium: { label: 'Palladium', f0: [0.733, 0.697, 0.652], rough: 0.07 },
  silver: { label: 'Sterling silver', f0: [0.95, 0.93, 0.88], rough: 0.06 },
  titanium: { label: 'Titanium', f0: [0.542, 0.497, 0.449], rough: 0.12 },
  tungsten: { label: 'Tungsten carbide', f0: [0.45, 0.44, 0.43], rough: 0.08 },
  blackRhodium: { label: 'Black rhodium', f0: [0.075, 0.073, 0.076], rough: 0.1 },
};

export const FINISHES = {
  polished: { label: 'High polish', rough: 0, aniso: 0, normal: null },
  satin: { label: 'Satin (brushed)', rough: 0.22, aniso: 0.85, normal: null },
  matte: { label: 'Matte (sandblasted)', rough: 0.45, aniso: 0, normal: null },
  hammered: { label: 'Hammered', rough: 0.05, aniso: 0, normal: 'hammered' },
};

let hammeredMap = null;
function getHammeredMap() {
  if (hammeredMap) return hammeredMap;
  // Voronoi dimples → height → normal map
  const S = 256;
  const cells = [];
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 60; i++) cells.push([rnd() * S, rnd() * S, 0.6 + rnd() * 0.6]);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = Infinity;
      let k = 1;
      for (const [cx, cy, kk] of cells) {
        for (let oy = -S; oy <= S; oy += S) for (let ox = -S; ox <= S; ox += S) {
          const d = (x - cx - ox) ** 2 + (y - cy - oy) ** 2;
          if (d < d1) { d1 = d; k = kk; }
        }
      }
      h[y * S + x] = Math.sqrt(d1) * k;
    }
  }
  const data = new Uint8Array(S * S * 4);
  const strength = 0.12;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
      const hy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
      let nx = -hx * strength, ny = -hy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * S + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255; data[i + 1] = (ny * 0.5 + 0.5) * 255; data[i + 2] = (nz * 0.5 + 0.5) * 255; data[i + 3] = 255;
    }
  }
  hammeredMap = new THREE.DataTexture(data, S, S);
  hammeredMap.wrapS = hammeredMap.wrapT = THREE.RepeatWrapping;
  hammeredMap.generateMipmaps = true;
  hammeredMap.minFilter = THREE.LinearMipmapLinearFilter;
  hammeredMap.colorSpace = THREE.NoColorSpace;
  hammeredMap.needsUpdate = true;
  return hammeredMap;
}

export function createMetalMaterial(metalKey, finishKey = 'polished', envMap = null) {
  const m = METALS[metalKey] || METALS.platinum;
  const f = FINISHES[finishKey] || FINISHES.polished;
  const mat = new THREE.MeshPhysicalMaterial({
    metalness: 1,
    roughness: Math.min(1, m.rough + f.rough),
    envMap,
    envMapIntensity: 1,
  });
  mat.color.setRGB(m.f0[0], m.f0[1], m.f0[2], THREE.LinearSRGBColorSpace);
  if (f.aniso) { mat.anisotropy = f.aniso; mat.anisotropyRotation = 0; }
  if (f.normal === 'hammered') {
    mat.normalMap = getHammeredMap();
    mat.normalScale = new THREE.Vector2(1, 1);
  }
  mat.userData.metalKey = metalKey;
  return mat;
}
