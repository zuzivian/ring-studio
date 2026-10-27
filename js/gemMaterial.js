// Gem shader: traces light through the actual facet planes of the stone.
//
// Entry: the rasterised front facet gives the entry point and normal. The ray
// splits by the Fresnel equations, refracts in, and bounces between facet
// planes (total internal reflection or partial reflection) until its energy is
// spent. Each exit samples the environment cube. Dispersion comes from tracing
// several wavelengths with their own refractive index; body colour from
// Beer–Lambert absorption over the path length in millimetres.

import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec3 vLocalPos;
flat varying vec3 vLocalNormal;
flat varying vec3 vLocalCam;
flat varying mat3 vRot;
flat varying float vScale;

void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec4 wp = m * vec4( position, 1.0 );
  mat3 rs = mat3( m );
  float s = length( rs[ 0 ] );
  vScale = s;
  vRot = rs / s;
  vLocalCam = transpose( vRot ) * ( cameraPosition - m[ 3 ].xyz ) / s;
  vLocalPos = position;
  vLocalNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
uniform samplerCube envMap;
uniform float envIntensity;
uniform vec4 planes[ NUM_PLANES ];
uniform float iors[ NUM_SAMPLES ];
uniform float iorStep;
uniform vec3 wts[ NUM_SAMPLES ];
uniform vec3 absorb;
uniform vec4 incl[ 8 ];
uniform int inclCount;
uniform vec3 inclTransmit;
uniform float haze;
uniform vec3 ambient;
uniform vec3 fluor;
uniform int maxBounces;

varying vec3 vLocalPos;
flat varying vec3 vLocalNormal;
flat varying vec3 vLocalCam;
flat varying mat3 vRot;
flat varying float vScale;

vec3 envLookup( vec3 dLocal ) {
  return textureCube( envMap, vRot * dLocal ).rgb * envIntensity;
}

// unpolarised Fresnel reflectance; eta = n_incident / n_transmitted
float fresnel( float cosi, float eta ) {
  float sint2 = eta * eta * ( 1.0 - cosi * cosi );
  if ( sint2 >= 1.0 ) return 1.0;
  float cost = sqrt( 1.0 - sint2 );
  float rs = ( eta * cosi - cost ) / ( eta * cosi + cost );
  float rp = ( cosi - eta * cost ) / ( cosi + eta * cost );
  return clamp( 0.5 * ( rs * rs + rp * rp ), 0.0, 1.0 );
}

void main() {
  vec3 N = normalize( vLocalNormal );
  vec3 V = normalize( vLocalPos - vLocalCam );
  float cosi = clamp( - dot( V, N ), 0.0, 1.0 );
  vec3 color = vec3( 0.0 );
  // shift every wavelength sample by a per-pixel fraction of a band, so the
  // fire blends into a continuous spectrum instead of a few coloured fringes
  float jitter = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5;

  // light actually in the room, for what inclusions and haze scatter toward us:
  // the cube averaged over six directions, weighted toward the sky, so a hazy
  // stone glows under a softbox and goes dark at a candlelit table
  vec3 room = ( envLookup( vec3( 0.0, 1.0, 0.0 ) ) * 2.0 + envLookup( vec3( 0.0, -1.0, 0.0 ) ) * 0.5
             + envLookup( vec3( 1.0, 0.0, 0.0 ) ) + envLookup( vec3( -1.0, 0.0, 0.0 ) )
             + envLookup( vec3( 0.0, 0.0, 1.0 ) ) + envLookup( vec3( 0.0, 0.0, -1.0 ) ) ) / 6.5;
  room = min( room, vec3( 1.5 ) );

  for ( int s = 0; s < NUM_SAMPLES; s ++ ) {
    float n = iors[ s ] + jitter * iorStep;
    float F = fresnel( cosi, 1.0 / n );
    vec3 acc = envLookup( reflect( V, N ) ) * F;
    vec3 dir = refract( V, N, 1.0 / n );
    vec3 pos = vLocalPos;
    vec3 thr = vec3( 1.0 - F );

    for ( int b = 0; b < MAX_BOUNCES; b ++ ) {
      if ( b >= maxBounces ) break;
      float tMin = 1e6;
      vec3 nHit = vec3( 0.0, 1.0, 0.0 );
      for ( int i = 0; i < NUM_PLANES; i ++ ) {
        vec4 pl = planes[ i ];
        float dn = dot( dir, pl.xyz );
        if ( dn > 1e-6 ) {
          float t = ( pl.w - dot( pos, pl.xyz ) ) / dn;
          if ( t > 1e-6 && t < tMin ) { tMin = t; nHit = pl.xyz; }
        }
      }
      if ( tMin > 1e5 ) break;
      float seg = tMin * vScale;

      // what scatters toward us from inside still crosses the body on the way
      // out, so a hazy emerald glows green, not milky white
      vec3 body = exp( - absorb * seg );
      // inclusions along this segment
      for ( int k = 0; k < 8; k ++ ) {
        if ( k >= inclCount ) break;
        vec3 oc = pos - incl[ k ].xyz;
        float bq = dot( oc, dir );
        float cq = dot( oc, oc ) - incl[ k ].w * incl[ k ].w;
        float disc = bq * bq - cq;
        if ( disc > 0.0 ) {
          float t0 = - bq - sqrt( disc );
          if ( t0 > 0.0 && t0 < tMin ) {
            acc += thr * room * body * 0.08;
            thr *= inclTransmit;
          }
        }
      }

      if ( haze > 0.0 ) {
        float scat = 1.0 - exp( - haze * seg );
        acc += thr * scat * room * body * 0.9;
        thr *= 1.0 - scat;
      }
      thr *= body;
      pos += dir * tMin;

      float c = dot( dir, nHit );
      float Fi = fresnel( c, n );
      if ( Fi < 1.0 ) {
        vec3 outDir = refract( dir, - nHit, n );
        acc += thr * ( 1.0 - Fi ) * envLookup( outDir );
      }
      thr *= Fi;
      dir = reflect( dir, nHit );
      if ( max( thr.r, max( thr.g, thr.b ) ) < 0.003 ) break;
    }
    // light still trapped after the last bounce leaves roughly where it points
    acc += thr * envLookup( dir ) * 0.6;
    color += acc * wts[ s ];
  }

  color += fluor;
  gl_FragColor = vec4( max( color, vec3( 0.0 ) ), 1.0 );
}
`;

// CIE 1931 colour matching (Wyman, Sloan & Shirley 2013 multi-lobe fit)
function g(x, mu, s1, s2) { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); }
function cmf(l) {
  const x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}
function xyzToRgb([x, y, z]) {
  return [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];
}

const spectralCache = new Map();
// split 400–700 nm into `count` bands; return band centres and RGB weights that sum to white
export function spectralBands(count) {
  if (spectralCache.has(count)) return spectralCache.get(count);
  const lo = 400, hi = 700, w = (hi - lo) / count;
  const bands = [];
  const sum = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const rgb = [0, 0, 0];
    for (let k = 0; k < 20; k++) {
      const l = lo + w * (i + (k + 0.5) / 20);
      const c = xyzToRgb(cmf(l));
      for (let j = 0; j < 3; j++) rgb[j] += Math.max(0, c[j]);
    }
    bands.push({ lambda: lo + w * (i + 0.5), rgb });
    for (let j = 0; j < 3; j++) sum[j] += rgb[j];
  }
  for (const b of bands) b.rgb = b.rgb.map((v, j) => v / sum[j]);
  spectralCache.set(count, bands);
  return bands;
}

// refractive index at wavelength (nm) from n_D and B–G dispersion, Cauchy fit
export function iorAt(nD, dispersion, lambdaNm) {
  const B = dispersion / (1 / 0.4308 ** 2 - 1 / 0.6867 ** 2);
  const A = nD - B / 0.5893 ** 2;
  const l = lambdaNm / 1000;
  return A + B / (l * l);
}

export function createGemMaterial(gem, { samples = 5, bounces = 8, instanced = false } = {}) {
  const planes = gem.planes.map((p) => new THREE.Vector4(p[0], p[1], p[2], p[3]));
  const bands = spectralBands(samples);
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines: { NUM_PLANES: planes.length, NUM_SAMPLES: samples, MAX_BOUNCES: bounces },
    uniforms: {
      envMap: { value: null },
      envIntensity: { value: 1 },
      planes: { value: planes },
      iors: { value: bands.map(() => 2.417) },
      iorStep: { value: 0 },
      wts: { value: bands.map((b) => new THREE.Vector3(...b.rgb)) },
      absorb: { value: new THREE.Vector3() },
      incl: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      inclCount: { value: 0 },
      inclTransmit: { value: new THREE.Vector3(0.12, 0.12, 0.12) },
      haze: { value: 0 },
      ambient: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
      fluor: { value: new THREE.Vector3() },
      maxBounces: { value: bounces },
    },
  });
  mat.userData.bands = bands;
  mat.userData.instanced = instanced;
  return mat;
}

// optics: { ior, dispersion, absorb: [r,g,b] per mm, haze, inclusions: {list}, fluor: [r,g,b] }
export function applyOptics(mat, optics) {
  const u = mat.uniforms;
  const bands = mat.userData.bands;
  u.iors.value = bands.map((b) => iorAt(optics.ior, optics.dispersion, b.lambda));
  u.iorStep.value = bands.length > 1 ? Math.abs(u.iors.value[0] - u.iors.value[bands.length - 1]) / (bands.length - 1) : 0;
  u.absorb.value.set(...optics.absorb);
  u.haze.value = optics.haze || 0;
  const list = (optics.inclusions && optics.inclusions.list) || [];
  u.inclCount.value = list.length;
  list.forEach((p, i) => u.incl.value[i].set(p[0], p[1], p[2], p[3]));
  u.fluor.value.set(...(optics.fluor || [0, 0, 0]));
}
