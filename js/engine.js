// Rendering engine.
//
// Passes per frame:
//   reflections  global cube (environment only) → prefiltered for metals;
//                local cube at the stone (environment + metal + skin) → stones
//   ring         ring only, into an HDR target with coverage alpha; also
//                refreshes the key light's shadow map
//   background   photo (or studio backdrop) with contact shadows multiplied in
//   composite    tone-map the ring, blend over the background, add softness,
//                grain and highlight bloom to match the photo

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Environment } from './lighting.js';
import { L, mask } from './layers.js';

const CAM_DISTANCE = 300; // mm: assumed phone-to-hand distance

const catcherVertex = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
varying vec3 vLocal;
varying vec3 vLocalNormal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
void main() {
  vLocal = position;
  vLocalNormal = normal;
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldNormal = normalize( ( modelMatrix * vec4( normal, 0.0 ) ).xyz );
  vViewDir = normalize( cameraPosition - wp.xyz );
}`;

const catcherFragment = /* glsl */ `
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
uniform float shadowStrength;
uniform float aoStrength;
uniform float bandHalf;
uniform vec3 headPos;
uniform float headR;
uniform float weddingOn;
uniform float weddingZ;
uniform float weddingHalf;
uniform float groundMode;
uniform vec3 contact;
varying vec3 vLocal;
varying vec3 vLocalNormal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
void main() {
  float sh = 1.0 - getShadowMask();
  float ao = 0.0;
  if ( groundMode > 0.5 ) {
    vec2 d = vLocal.xz - contact.xz;
    ao = exp( - dot( d, d ) / 6.0 ) * 0.75 + exp( - dot( d, d ) / 60.0 ) * 0.25;
  } else {
    float dz = abs( vLocal.z ) - bandHalf;
    ao = dz < 0.0 ? 1.0 : exp( - dz / 0.75 ) * 0.85;
    if ( weddingOn > 0.5 ) {
      float dw = abs( vLocal.z - weddingZ ) - weddingHalf;
      ao = max( ao, dw < 0.0 ? 1.0 : exp( - dw / 0.75 ) * 0.85 );
    }
    vec3 toHead = headPos - vLocal;
    float dist = length( toHead );
    float cosT = max( dot( normalize( vLocalNormal ), toHead / dist ), 0.0 );
    ao = max( ao, clamp( headR * headR / ( dist * dist ) * cosT, 0.0, 1.0 ) * 0.9 );
  }
  float facing = groundMode > 0.5 ? 1.0 : smoothstep( 0.08, 0.45, dot( normalize( vWorldNormal ), normalize( vViewDir ) ) );
  float along = groundMode > 0.5 ? 1.0 : 1.0 - smoothstep( 7.0, 15.0, abs( vLocal.z ) );
  float dark = clamp( sh * shadowStrength + ao * aoStrength, 0.0, groundMode > 0.5 ? 0.9 : 0.6 ) * facing * along;
  gl_FragColor = vec4( vec3( 1.0 - dark ), 1.0 );
}`;

const quadVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

const backdropFragment = /* glsl */ `
uniform vec3 top;
uniform vec3 bottom;
varying vec2 vUv;
void main() {
  vec3 c = mix( bottom, top, smoothstep( 0.0, 1.0, vUv.y ) );
  float v = 1.0 - 0.18 * length( ( vUv - vec2( 0.5, 0.55 ) ) * vec2( 1.2, 1.0 ) );
  gl_FragColor = vec4( c * v, 1.0 );
}`;

const compositeFragment = /* glsl */ `
uniform sampler2D tBg;
uniform sampler2D tRing;
uniform vec2 texel;
uniform float exposure;
uniform vec3 tint;
uniform float softness;
uniform float grain;
uniform float bloom;
uniform float glints;
uniform float saturation;
uniform float encodeSRGB;
uniform float pixelScale;
varying vec2 vUv;

vec3 neutral( vec3 color ) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min( color.r, min( color.g, color.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < startCompression ) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / ( peak + d - startCompression );
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
  return mix( color, vec3( newPeak ), g );
}
float hash( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
vec3 toSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}
vec3 bright( vec2 uv ) {
  vec4 s = texture2D( tRing, uv );
  return max( s.rgb * tint * exposure - vec3( 1.0 ), vec3( 0.0 ) );
}
void main() {
  vec4 r;
  if ( softness > 0.05 ) {
    r = vec4( 0.0 );
    float ws = 0.0;
    for ( int i = - 2; i <= 2; i ++ ) for ( int j = - 2; j <= 2; j ++ ) {
      vec2 o = vec2( float( i ), float( j ) );
      float w = exp( - dot( o, o ) / 2.5 );
      r += texture2D( tRing, vUv + o * texel * softness * 0.6 ) * w;
      ws += w;
    }
    r /= ws;
  } else {
    r = texture2D( tRing, vUv );
  }
  vec3 bg = texture2D( tBg, vUv ).rgb;
  vec3 rc = r.a > 1e-4 ? r.rgb / r.a : vec3( 0.0 );
  rc *= tint * exposure;
  vec3 tm = neutral( rc );
  float l = dot( tm, vec3( 0.2126, 0.7152, 0.0722 ) );
  tm = mix( vec3( l ), tm, saturation );
  vec3 outc = mix( bg, tm, r.a );

  vec3 glow = vec3( 0.0 );
  if ( bloom > 0.0 ) {
    // a filled disc (three rings plus the centre) so a point flash blooms
    // into a soft dot rather than a bullseye
    float R = 4.0 * pixelScale;
    glow += bright( vUv ) * 0.12;
    for ( int k = 0; k < 12; k ++ ) {
      float a = float( k ) * 0.5236 + ( mod( float( k ), 2.0 ) * 0.2618 );
      vec2 o = vec2( cos( a ), sin( a ) );
      glow += bright( vUv + o * R * 0.5 * texel ) * 0.08 + bright( vUv + o * R * texel ) * 0.05 + bright( vUv + o * R * 1.8 * texel ) * 0.025;
    }
    glow *= bloom;
  }
  if ( glints > 0.0 ) {
    vec3 st = vec3( 0.0 );
    for ( int k = 1; k <= 7; k ++ ) {
      float f = float( k ) * 2.2 * pixelScale;
      float w = 1.0 - float( k ) / 8.0;
      st += ( bright( vUv + vec2( f, f ) * texel * 0.7 ) + bright( vUv - vec2( f, f ) * texel * 0.7 ) +
              bright( vUv + vec2( f, - f ) * texel * 0.7 ) + bright( vUv - vec2( f, - f ) * texel * 0.7 ) ) * w * w;
    }
    glow += st * glints * 0.05;
  }
  outc = 1.0 - ( 1.0 - outc ) * ( 1.0 - clamp( glow, 0.0, 1.0 ) );
  if ( grain > 0.0 ) outc += ( hash( gl_FragCoord.xy ) - 0.5 ) * grain * 0.05 * max( r.a, 0.15 );
  outc = clamp( outc, 0.0, 1.0 );
  gl_FragColor = vec4( encodeSRGB > 0.5 ? toSRGB( outc ) : outc, 1.0 );
}`;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.mode = 'studio';
    this.dirty = { env: true, capture: true, shadow: true, frame: true };
    this.look = { exposure: 1, tint: [1, 1, 1], softness: 0, grain: 0, bloom: 0.35, glints: 0, saturation: 1, shadow: 0.45, ao: 0.4 };
    this.view = { zoom: 1, cx: 0.5, cy: 0.5 };
    this.backdrop = 'light';
    this.quality = { pixelRatio: Math.min(window.devicePixelRatio || 1, 2) };

    // environment
    this.env = new Environment(this.scene);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.globalRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.globalCube = new THREE.CubeCamera(1, 4000, this.globalRT);
    this.globalCube.layers.mask = mask(L.ENV);
    this.scene.add(this.globalCube);
    this.gemRT = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.gemCube = new THREE.CubeCamera(0.3, 4000, this.gemRT);
    this.gemCube.layers.mask = mask(L.ENV, L.METAL, L.SKIN);
    this.scene.add(this.gemCube);
    this.envMap = null;

    // ring root (pose) with the finger stand-ins attached
    this.ringRoot = new THREE.Group();
    this.scene.add(this.ringRoot);
    this.ringHolder = new THREE.Group();
    this.ringRoot.add(this.ringHolder);
    this.finger = new THREE.Group();
    this.ringRoot.add(this.finger);
    this.ring = null;

    // key light: shadows only (the environment does the shading)
    this.key = new THREE.DirectionalLight(0xffffff, 0);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24; sc.near = 1; sc.far = 200;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.03;
    this.key.layers.enableAll();
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    // photo
    this.photoTex = null;
    this.photoQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }));
    this.photoQuad.layers.set(L.BG);
    this.photoQuad.renderOrder = -5;
    this.photoQuad.visible = false;
    this.scene.add(this.photoQuad);

    // studio backdrop + ground
    this.backdropMat = new THREE.ShaderMaterial({
      vertexShader: quadVertex, fragmentShader: backdropFragment, depthTest: false, depthWrite: false,
      uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
    });
    this.backdropQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.backdropMat);
    this.backdropQuad.frustumCulled = false;
    this.backdropQuad.layers.set(L.BG);
    this.backdropQuad.renderOrder = -5;
    this.scene.add(this.backdropQuad);
    this.setBackdrop('light');

    this.catcherMat = this.makeCatcherMaterial(false);
    this.groundMat = this.makeCatcherMaterial(true);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.layers.set(L.BG);
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -4;
    this.scene.add(this.ground);

    // cameras
    this.handCam = new THREE.PerspectiveCamera(20, 1, 20, 2000);
    this.handCam.position.set(0, 0, CAM_DISTANCE);
    this.studioCam = new THREE.PerspectiveCamera(28, 1, 1, 3000);
    this.studioCam.position.set(34, 26, 62);
    this.controls = new OrbitControls(this.studioCam, canvas);
    this.controls.target.set(0, 2.5, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 22;
    this.controls.maxDistance = 220;
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => this.requestRender());

    // composite
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: quadVertex, fragmentShader: compositeFragment, depthTest: false, depthWrite: false,
      uniforms: {
        tBg: { value: null }, tRing: { value: null }, texel: { value: new THREE.Vector2() },
        exposure: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) }, softness: { value: 0 }, grain: { value: 0 },
        bloom: { value: 0.35 }, glints: { value: 0 }, saturation: { value: 1 }, encodeSRGB: { value: 1 }, pixelScale: { value: 1 },
      },
    });
    this.compositeScene = new THREE.Scene();
    const tri = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    tri.frustumCulled = false;
    this.compositeScene.add(tri);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.rtBg = null; this.rtRing = null;
    this.size = new THREE.Vector2(1, 1);
    this.placement = null;
    this.photoInfo = null;
    this.rock = false;
    this.clock = new THREE.Clock();
    this.onFrame = null;
    this._raf = null;
    this.loop = this.loop.bind(this);
    this._raf = requestAnimationFrame(this.loop);
  }

  makeCatcherMaterial(ground) {
    const m = new THREE.ShaderMaterial({
      vertexShader: catcherVertex,
      fragmentShader: catcherFragment,
      lights: true,
      depthWrite: !ground,
      depthTest: !ground,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {
        shadowStrength: { value: 0.45 }, aoStrength: { value: 0.4 }, bandHalf: { value: 1 },
        headPos: { value: new THREE.Vector3() }, headR: { value: 3 }, weddingOn: { value: 0 }, weddingZ: { value: 0 }, weddingHalf: { value: 1 },
        groundMode: { value: ground ? 1 : 0 }, contact: { value: new THREE.Vector3() },
      }]),
    });
    return m;
  }

  setBackdrop(kind) {
    this.backdrop = kind;
    const u = this.backdropMat.uniforms;
    if (kind === 'dark') { u.top.value.setRGB(0.05, 0.05, 0.055); u.bottom.value.setRGB(0.018, 0.018, 0.02); }
    else { u.top.value.setRGB(0.74, 0.74, 0.73); u.bottom.value.setRGB(0.5, 0.5, 0.49); }
    this.requestRender();
  }

  requestRender(kind = 'frame') {
    if (kind === 'env') { this.dirty.env = true; this.dirty.capture = true; this.dirty.shadow = true; }
    if (kind === 'capture') { this.dirty.capture = true; this.dirty.shadow = true; }
    if (kind === 'shadow') this.dirty.shadow = true;
    this.dirty.frame = true;
  }

  // ---- content -------------------------------------------------------------

  setRing(built) {
    if (this.ring) {
      this.ringHolder.remove(this.ring.group);
      this.ring.group.traverse((o) => { if (o.geometry && !o.userData.gem) o.geometry.dispose(); });
    }
    this.ring = built;
    this.ringHolder.add(built.group);
    for (const g of built.gems) g.material.uniforms.envMap.value = this.gemRT.texture;
    this.applyEnvMap(built.group);
    this.ringBottomY = this.ringBottom();
    this.rebuildFinger();
    this.updatePose();
    this.requestRender('capture');
  }

  applyEnvMap(root) {
    if (!this.envMap) return;
    root.traverse((o) => {
      const m = o.material;
      if (m && m.isMeshPhysicalMaterial && m.envMap !== this.envMap.texture) {
        if (!m.envMap) m.needsUpdate = true;
        m.envMap = this.envMap.texture;
      }
    });
  }

  setGemEnvIntensity(v) {
    if (!this.ring) return;
    for (const g of this.ring.gems) g.material.uniforms.envIntensity.value = v;
  }

  rebuildFinger() {
    for (const c of this.finger.children.slice()) { this.finger.remove(c); c.geometry.dispose(); }
    if (!this.ring) return;
    const o = this.ring.occluders;
    const R = o.innerR;
    const mkCyl = (r, x = 0) => new THREE.CylinderGeometry(r, r, 90, 72, 1, true).rotateX(Math.PI / 2).translate(x, 0, 0);
    // contact shadow + occlusion on the finger
    const catcher = new THREE.Mesh(mkCyl(R * 0.995), this.catcherMat);
    catcher.layers.set(L.BG);
    catcher.receiveShadow = true;
    catcher.renderOrder = -4;
    this.finger.add(catcher);
    this.catcher = catcher;
    // depth-only stand-ins that hide the back of the band
    const occMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    const occ = new THREE.Mesh(mkCyl(R * 0.985), occMat);
    occ.layers.set(L.OCCLUDER);
    occ.renderOrder = -3;
    this.finger.add(occ);
    if (this.fingersTogether) {
      for (const sgn of [-1, 1]) {
        const n = new THREE.Mesh(mkCyl(R * 0.95, sgn * R * 2.02), occMat);
        n.layers.set(L.OCCLUDER);
        n.renderOrder = -3;
        this.finger.add(n);
      }
    }
    // the finger as the stone sees it
    this.skinMat = this.skinMat || new THREE.MeshBasicMaterial({ color: 0xb08870 });
    const skin = new THREE.Mesh(mkCyl(R * 0.99), this.skinMat);
    skin.layers.set(L.SKIN);
    this.finger.add(skin);
    if (this.fingersTogether) {
      for (const sgn of [-1, 1]) {
        const n = new THREE.Mesh(mkCyl(R * 0.95, sgn * R * 2.02), this.skinMat);
        n.layers.set(L.SKIN);
        this.finger.add(n);
      }
    }
    const u = this.catcherMat.uniforms;
    u.bandHalf.value = o.bandHalfWidth;
    u.headPos.value.copy(o.head);
    u.headR.value = o.headRadius;
    u.weddingOn.value = o.wedding ? 1 : 0;
    if (o.wedding) { u.weddingZ.value = o.wedding.z; u.weddingHalf.value = o.wedding.width / 2; }
    this.finger.visible = this.mode === 'hand';
  }

  setFingersTogether(v) {
    this.fingersTogether = v;
    this.rebuildFinger();
    this.requestRender('capture');
  }

  setSkinColor(linear) {
    this.skinMat = this.skinMat || new THREE.MeshBasicMaterial();
    this.skinMat.color.setRGB(linear[0], linear[1], linear[2], THREE.LinearSRGBColorSpace);
    this.requestRender('capture');
  }

  setMode(mode) {
    this.mode = mode;
    this.env.setFrame(mode);
    this.controls.enabled = mode === 'studio';
    this.finger.visible = mode === 'hand';
    this.photoQuad.visible = mode === 'hand' && !!this.photoTex;
    this.backdropQuad.visible = mode === 'studio';
    this.ground.visible = mode === 'studio';
    this.env.setPhoto(mode === 'hand' ? this.photoSmall : null, this.photoMix ?? 0.6);
    this.updatePose();
    this.requestRender('env');
  }

  setPhoto(source, width, height, small) {
    if (this.photoTex) this.photoTex.dispose();
    const tex = new THREE.Texture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.photoTex = tex;
    this.photoQuad.material.map = tex;
    this.photoQuad.material.needsUpdate = true;
    this.photoInfo = { width, height };
    if (small) {
      if (this.photoSmall) this.photoSmall.dispose();
      this.photoSmall = new THREE.CanvasTexture(small);
      this.photoSmall.colorSpace = THREE.SRGBColorSpace;
    }
    this.view = { zoom: 1, cx: 0.5, cy: 0.5 };
    this.setMode(this.mode);
  }

  setPhotoMix(v) { this.photoMix = v; this.env.setPhoto(this.mode === 'hand' ? this.photoSmall : null, v); this.requestRender('env'); }

  // placement: { cx, cy (photo px), widthPx, dirX, dirY (fingertip direction, image coords), pitch, roll, slide (mm) } plus innerR
  setPlacement(p) { this.placement = p; this.updatePose(); this.requestRender('capture'); }

  pxPerMm() {
    if (!this.placement || !this.ring) return 1;
    return this.placement.widthPx / (2 * this.ring.occluders.innerR);
  }

  updatePose() {
    const root = this.ringRoot;
    if (this.mode === 'studio' || !this.placement || !this.photoInfo || !this.ring) {
      root.position.set(0, 0, 0);
      root.quaternion.identity();
      if (this.mode === 'studio' && this.ring) this.ground.position.set(0, -this.ringBottomY, 0);
    } else {
      const p = this.placement;
      const k = this.pxPerMm();
      const { width: iw, height: ih } = this.photoInfo;
      const F = new THREE.Vector3(p.dirX, -p.dirY, 0).normalize();
      const centre = new THREE.Vector3((p.cx - iw / 2) / k, -(p.cy - ih / 2) / k, 0).addScaledVector(F, p.slide || 0);
      const Y = new THREE.Vector3(0, 0, 1);
      const Z = F.clone().negate();
      const X = new THREE.Vector3().crossVectors(Y, Z);
      const q0 = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
      const qp = new THREE.Quaternion().setFromAxisAngle(X, THREE.MathUtils.degToRad(p.pitch || 0));
      const F2 = F.clone().applyQuaternion(qp);
      const qr = new THREE.Quaternion().setFromAxisAngle(F2, THREE.MathUtils.degToRad(p.roll || 0));
      root.quaternion.copy(qr.multiply(qp).multiply(q0));
      root.position.copy(centre);
      if (this.rock) {
        const t = this.clock.getElapsedTime();
        const wob = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(t * 1.3) * 0.07, Math.sin(t * 0.9) * 0.05, Math.sin(t * 1.1 + 1) * 0.04));
        root.quaternion.multiply(wob);
      }
      // camera and photo plane in millimetres
      const wmm = iw / k, hmm = ih / k;
      this.photoQuad.scale.set(wmm, hmm, 1);
      this.handCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(hmm / 2 / CAM_DISTANCE));
      this.handCam.aspect = iw / ih;
      this.handCam.updateProjectionMatrix();
    }
    if (this.mode === 'studio' && this.rock) {
      const t = this.clock.getElapsedTime();
      root.quaternion.setFromEuler(new THREE.Euler(Math.sin(t * 1.1) * 0.08, Math.sin(t * 0.7) * 0.18, 0));
    }
    root.updateMatrixWorld(true);
  }

  ringBottom() {
    if (!this.ring) return 10;
    const box = new THREE.Box3();
    this.ring.group.traverse((o) => { if (o.isMesh && o.name === 'band') { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
    return box.isEmpty() ? 10 : -box.min.y;
  }

  setLighting(presetKey, opts) {
    this.lightKey = presetKey;
    this.lightOpts = opts;
    this.env.build(presetKey, opts);
    this.requestRender('env');
  }

  setLightRotation(az, el) {
    this.env.setRotation(az, el);
    this.requestRender('env');
  }

  setLook(look) {
    Object.assign(this.look, look);
    const u = this.compositeMat.uniforms;
    u.exposure.value = this.look.exposure;
    u.tint.value.set(...this.look.tint);
    u.softness.value = this.look.softness;
    u.grain.value = this.look.grain;
    u.bloom.value = this.look.bloom;
    u.glints.value = this.look.glints;
    u.saturation.value = this.look.saturation;
    // On a finger the light is large and close (a room, a window), so the
    // shadow is softer and lighter than on the studio table.
    const hand = this.mode === 'hand';
    const shadowScale = (this.env.preset ? this.env.preset.shadow / 0.45 : 1) * (hand ? 0.5 : 1);
    this.key.shadow.radius = Math.max(hand ? 5 : 1, (this.env.preset ? this.env.preset.shadowRadius : 6) * (hand ? 1.6 : 1));
    for (const m of [this.catcherMat, this.groundMat]) {
      m.uniforms.shadowStrength.value = this.look.shadow * shadowScale;
      m.uniforms.aoStrength.value = this.look.ao;
    }
    this.requestRender();
  }

  setView(zoom, cx, cy) {
    const z = Math.max(1, Math.min(zoom, 12));
    const half = 0.5 / z;
    this.view = { zoom: z, cx: Math.min(1 - half, Math.max(half, cx)), cy: Math.min(1 - half, Math.max(half, cy)) };
    this.requestRender();
  }

  // ---- coordinates (hand mode) ----------------------------------------------
  photoToCanvas(px, py) {
    const { width: iw, height: ih } = this.photoInfo;
    const v = this.view;
    const u = px / iw, w = py / ih;
    return [((u - v.cx) * v.zoom + 0.5) * this.size.x, ((w - v.cy) * v.zoom + 0.5) * this.size.y];
  }
  canvasToPhoto(sx, sy) {
    const { width: iw, height: ih } = this.photoInfo;
    const v = this.view;
    return [((sx / this.size.x - 0.5) / v.zoom + v.cx) * iw, ((sy / this.size.y - 0.5) / v.zoom + v.cy) * ih];
  }

  // ---- rendering ------------------------------------------------------------
  resize(w, h) {
    this.size.set(Math.max(1, w), Math.max(1, h));
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(this.size.x, this.size.y, false);
    this.canvas.style.width = this.size.x + 'px';
    this.canvas.style.height = this.size.y + 'px';
    this.allocTargets(Math.round(this.size.x * this.quality.pixelRatio), Math.round(this.size.y * this.quality.pixelRatio));
    this.studioCam.aspect = this.size.x / this.size.y;
    this.studioCam.updateProjectionMatrix();
    this.requestRender();
  }

  allocTargets(w, h) {
    if (this.rtBg && this.rtBg.width === w && this.rtBg.height === h) return;
    if (this.rtBg) { this.rtBg.dispose(); this.rtRing.dispose(); }
    this.rtBg = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    this.rtRing = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
  }

  activeCamera(w, h) {
    if (this.mode === 'studio' || !this.placement || !this.photoInfo) return this.studioCam;
    // placement may exist before the ring is shown (photo just loaded)
    const cam = this.handCam;
    const v = this.view;
    if (v.zoom > 1.0001) {
      const fw = w * v.zoom, fh = h * v.zoom;
      cam.setViewOffset(fw, fh, v.cx * fw - w / 2, v.cy * fh - h / 2, w, h);
    } else cam.clearViewOffset();
    return cam;
  }

  captureReflections() {
    const r = this.renderer;
    const centre = new THREE.Vector3();
    this.ringRoot.getWorldPosition(centre);
    this.env.place(centre);
    if (this.dirty.env) {
      this.globalCube.position.copy(centre);
      this.globalCube.update(r, this.scene);
      if (this.envMap) this.envMap.dispose();
      this.envMap = this.pmrem.fromCubemap(this.globalRT.texture);
      this.applyEnvMap(this.scene);
      this.dirty.env = false;
    }
    if (this.ring) {
      const p = this.ring.capturePoint.clone();
      this.ringHolder.localToWorld(p);
      this.gemCube.position.copy(p);
      this.gemCube.update(r, this.scene);
    }
    this.dirty.capture = false;
  }

  renderPasses(target, w, h, cam) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    // key light follows the ring
    const centre = new THREE.Vector3();
    this.ringRoot.getWorldPosition(centre);
    this.key.target.position.copy(centre);
    // over a hand the light is above the camera too, so the shadow stays
    // close under the ring instead of streaking down the finger
    const keyDir = this.mode === 'hand' ? this.env.keyDir.clone().add(new THREE.Vector3(0, 0, 1.2)).normalize() : this.env.keyDir;
    this.key.position.copy(centre).addScaledVector(keyDir, 80);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();

    const camMask = cam.layers.mask;
    // ring pass (also refreshes the shadow map)
    cam.layers.mask = mask(L.METAL, L.GEM, L.OCCLUDER);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(target.ring);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, cam);
    // background pass
    cam.layers.mask = mask(L.BG);
    r.shadowMap.needsUpdate = false;
    r.setRenderTarget(target.bg);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.scene, cam);
    cam.layers.mask = camMask;
    // composite
    const u = this.compositeMat.uniforms;
    u.tBg.value = target.bg.texture;
    u.tRing.value = target.ring.texture;
    u.texel.value.set(1 / w, 1 / h);
    u.encodeSRGB.value = 1;
    r.setRenderTarget(target.out || null);
    r.render(this.compositeScene, this.orthoCam);
    r.setRenderTarget(prevTarget);
  }

  render() {
    this.updatePose();
    this.ringRoot.visible = this.mode === 'studio' || this.ringVisible !== false;
    if (this.dirty.env || this.dirty.capture || this.rock) this.captureReflections();
    const w = this.rtBg.width, h = this.rtBg.height;
    const cam = this.activeCamera(w, h);
    // grain and softness are measured in photo pixels
    const u = this.compositeMat.uniforms;
    const photoScale = this.mode === 'hand' && this.photoInfo ? (w * this.view.zoom) / this.photoInfo.width : 1;
    u.softness.value = this.look.softness * photoScale;
    u.pixelScale.value = Math.max(0.6, Math.min(3, w / 900));
    this.renderPasses({ bg: this.rtBg, ring: this.rtRing, out: null }, w, h, cam);
    this.dirty.frame = false;
    this.dirty.shadow = false;
  }

  loop() {
    this._raf = requestAnimationFrame(this.loop);
    // OrbitControls fires 'change' while it damps, which requests frames
    if (this.mode === 'studio') this.controls.update();
    if (!this.rtBg) return;
    if (this.dirty.frame || this.rock) {
      this.render();
      if (this.onFrame) this.onFrame();
    }
  }

  // Render the current view at full photo resolution (hand mode) or a fixed size (studio)
  async exportImage(maxSide = 2400) {
    let w, h, cam;
    const prevView = { ...this.view };
    if (this.mode === 'hand' && this.photoInfo && this.placement) {
      const { width: iw, height: ih } = this.photoInfo;
      const sc = Math.min(1, maxSide / Math.max(iw, ih));
      w = Math.round(iw * sc); h = Math.round(ih * sc);
      this.view = { zoom: 1, cx: 0.5, cy: 0.5 };
      cam = this.handCam;
      cam.clearViewOffset();
    } else {
      const aspect = this.size.x / this.size.y;
      w = aspect >= 1 ? 2000 : Math.round(2000 * aspect);
      h = aspect >= 1 ? Math.round(2000 / aspect) : 2000;
      cam = this.studioCam;
    }
    const bg = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    const ring = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    const out = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType });
    const u = this.compositeMat.uniforms;
    const prevSoft = u.softness.value, prevScale = u.pixelScale.value;
    u.softness.value = this.mode === 'hand' && this.photoInfo ? this.look.softness * (w / this.photoInfo.width) : this.look.softness;
    u.pixelScale.value = Math.max(0.6, Math.min(3, w / 900));
    this.updatePose();
    this.captureReflections();
    this.renderPasses({ bg, ring, out }, w, h, cam);
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(out, 0, 0, w, h, px);
    bg.dispose(); ring.dispose(); out.dispose();
    u.softness.value = prevSoft; u.pixelScale.value = prevScale;
    this.view = prevView;
    this.requestRender();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => c.toBlob((b) => res({ blob: b, canvas: c }), 'image/png'));
  }

  // focus: { x, y, size } in CSS pixels on the canvas; defaults to the centre square
  thumbnail(size = 220, focus = null) {
    const c = document.createElement('canvas');
    const a = this.canvas;
    const pr = a.width / this.size.x;
    let s = Math.min(a.width, a.height), x = (a.width - s) / 2, y = (a.height - s) / 2;
    if (focus) {
      s = Math.min(s, Math.max(48, focus.size * pr));
      x = Math.min(a.width - s, Math.max(0, focus.x * pr - s / 2));
      y = Math.min(a.height - s, Math.max(0, focus.y * pr - s / 2));
    }
    c.width = c.height = size;
    this.render();
    c.getContext('2d').drawImage(a, x, y, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.82);
  }
}
