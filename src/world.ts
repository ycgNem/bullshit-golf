import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl, type Course } from './course';
import { makeTerrainMaterial, type TerrainTextures, type TerrainUniforms } from './terrainMaterial';

export type Quality = 'low' | 'medium' | 'high';

/** Direction towards the sun (matches the Blender scene: elevation 40, azimuth 290). */
export const SUN_DIR = new THREE.Vector3(-0.72, 0.643, -0.262).normalize();
const HORIZON = new THREE.Color().setRGB(0.6, 0.72, 0.84);
const TREE_H = [14, 17, 11, 15.5];
const SHADOW_R = 120;
const MODEL_NAMES = ['ball', 'peg', 'flagstick', 'marker', 'bench', 'rake', 'cart', 'gator', 'bridge', 'sign_h7', 'sign_h8',
  'log_1', 'log_2', 'log_3', 'log_4', 'tree_1', 'tree_2', 'tree_3', 'tree_4'] as const;

export interface TreeVariant {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; leaves: boolean }[];
  leafMin: THREE.Vector3;
  leafMax: THREE.Vector3;
}

interface Floater { obj: THREE.Object3D; y: number; phase: number; yaw: number; gator: boolean; snap: number }

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * p;
    gl_Position.z = gl_Position.w;
  }`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uSun;
  uniform float uTime;
  uniform float uDisc;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
    return s;
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = max(d.y, 0.0);
    vec3 zen = vec3(0.085, 0.215, 0.55);
    vec3 hor = vec3(${HORIZON.r.toFixed(3)}, ${HORIZON.g.toFixed(3)}, ${HORIZON.b.toFixed(3)});
    vec3 col = mix(hor, zen, 1.0 - pow(1.0 - h, 2.6));
    float sd = max(dot(d, uSun), 0.0);
    col += vec3(1.0, 0.86, 0.66) * (pow(sd, 6.0) * 0.10 + pow(sd, 90.0) * 0.35);
    col += vec3(1.0, 0.96, 0.88) * smoothstep(0.99965, 0.99985, sd) * 24.0 * uDisc;
    if (d.y > 0.0) {
      vec2 p = d.xz / (d.y + 0.16) * 1.15 + uTime * vec2(0.0035, 0.0016);
      float c = smoothstep(0.50, 0.80, fbm(p * 1.25));
      float lit = fbm(p * 1.25 + uSun.xz * 0.22);
      vec3 cc = mix(vec3(0.60, 0.65, 0.72), vec3(1.02, 1.0, 0.97), smoothstep(0.62, 0.34, lit));
      cc += vec3(0.5, 0.42, 0.3) * pow(sd, 14.0);
      col = mix(col, cc, c * smoothstep(0.0, 0.14, d.y) * 0.9);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function hash2(x: number, y: number, s: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function vnoise(x: number, y: number, s: number): number {
  const i = Math.floor(x), j = Math.floor(y);
  let u = x - i, v = y - j;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm(x: number, y: number, s: number, oct = 4): number {
  let a = 0.5, t = 0;
  for (let o = 0; o < oct; o++) { t += a * vnoise(x, y, s + o * 13); x *= 2.03; y *= 2.03; a *= 0.5; }
  return t;
}
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 1, 0.1, 6000);
  readonly models = new Map<string, THREE.Object3D>();
  readonly trees: TreeVariant[] = [];
  readonly wind = new THREE.Vector3();
  /** Gator positions (game x, z) for the hole in play. */
  readonly gators: { x: number; z: number; yaw: number }[] = [];
  flagstick: THREE.Object3D | null = null;
  private flag: THREE.Object3D | null = null;
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 3.3);
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms = { uSun: { value: SUN_DIR }, uTime: { value: 0 }, uDisc: { value: 1 } };
  private readonly timeUniform = { value: 0 };
  private holeGroup = new THREE.Group();
  private terrainTex!: TerrainTextures;
  private waterN!: THREE.Texture;
  private terrainUniforms: TerrainUniforms | null = null;
  private cupLiner: THREE.Group | null = null;
  private floaters: Floater[] = [];
  private course: Course | null = null;
  private quality: Quality = 'high';
  private readonly shadowFocus = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.fog = new THREE.FogExp2(HORIZON, 0.0012);
    this.scene.add(this.holeGroup);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(4500, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    // Image-based light from the same sky (without the sun disc: the directional light is the sun).
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(this.sky.geometry, new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 }, uDisc: { value: 0 } },
    }));
    envSky.scale.setScalar(0.01);
    envScene.add(envSky);
    this.scene.environment = pm.fromScene(envScene, 0, 0.1, 100).texture;
    this.scene.environmentIntensity = 0.85;
    pm.dispose();

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_R; sc.right = SHADOW_R; sc.top = SHADOW_R; sc.bottom = -SHADOW_R;
    sc.near = 10; sc.far = 700;
    this.scene.add(this.sun, this.sun.target);
    this.setQuality('high');
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const cap = q === 'low' ? 1 : q === 'medium' ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
    const size = q === 'low' ? 1024 : q === 'medium' ? 2048 : 4096;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadShared(onProgress: (f: number) => void): Promise<void> {
    const tl = new THREE.TextureLoader();
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    let done = 0;
    const total = 11 + MODEL_NAMES.length;
    const tick = (): void => onProgress(++done / total);
    const tex = async (name: string, srgb: boolean): Promise<THREE.Texture> => {
      const t = await tl.loadAsync(assetUrl(`tex/${name}.webp`));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso;
      tick();
      return t;
    };
    const [roughC, roughN, fairC, fairN, greenC, greenN, sandC, sandN, pathC, , waterN] = await Promise.all([
      tex('Rough_c', true), tex('Rough_n', false), tex('Fairway_c', true), tex('Fairway_n', false),
      tex('Green_c', true), tex('Green_n', false), tex('Sand_c', true), tex('Sand_n', false),
      tex('Concrete_c', true), tex('Concrete_n', false), tex('Water_n', false),
    ]);
    this.terrainTex = { roughC, roughN, fairC, fairN, greenC, greenN, sandC, sandN, pathC };
    this.waterN = waterN;

    const gl = new GLTFLoader();
    await Promise.all(MODEL_NAMES.map(async (name) => {
      const g = await gl.loadAsync(assetUrl(`${name}.glb`));
      g.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          (o.geometry as THREE.BufferGeometry).userData.shared = true;
          for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as THREE.Material[]) {
            m.userData.shared = true;
            if (m instanceof THREE.MeshStandardMaterial && m.map) m.map.anisotropy = aniso;
          }
        }
      });
      this.models.set(name, g.scene);
      tick();
    }));
    for (let v = 0; v < 4; v++) this.trees.push(this.prepareTree(this.models.get(`tree_${v + 1}`)!));
  }

  private prepareTree(root: THREE.Object3D): TreeVariant {
    const variant: TreeVariant = { parts: [], leafMin: new THREE.Vector3(), leafMax: new THREE.Vector3() };
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const geometry = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
      geometry.userData.shared = true;
      const src = o.material as THREE.MeshStandardMaterial;
      const leaves = src.name.includes('Leaves');
      const material = src.clone();
      material.userData.shared = true;
      if (leaves) {
        geometry.computeBoundingBox();
        variant.leafMin.copy(geometry.boundingBox!.min);
        variant.leafMax.copy(geometry.boundingBox!.max);
        material.side = THREE.DoubleSide;
        material.alphaTest = 0.4;
        material.transparent = false;
        material.alphaToCoverage = true;
        material.roughness = 0.72;
        material.envMapIntensity = 0.7;
        const time = this.timeUniform;
        material.onBeforeCompile = (sh) => {
          sh.uniforms.uTime = time;
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
              #ifdef USE_INSTANCING
                float swp = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.17;
              #else
                float swp = 0.0;
              #endif
              float swa = 0.012 * position.y;
              transformed.x += sin(uTime * 1.1 + swp + position.y * 0.35) * swa + sin(uTime * 2.7 + position.x * 1.3 + swp) * 0.03;
              transformed.z += cos(uTime * 0.9 + swp * 1.3 + position.y * 0.3) * swa + sin(uTime * 3.1 + position.z * 1.1 + swp) * 0.03;`);
          sh.fragmentShader = sh.fragmentShader
            // crown-shaped normals are authored: do not flip them on back faces
            .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
            .replace('#include <alphatest_fragment>', /* glsl */ `
              vec2 lodx = dFdx(vMapUv * 512.0), lody = dFdy(vMapUv * 512.0);
              float lod = 0.5 * log2(max(dot(lodx, lodx), dot(lody, lody)));
              diffuseColor.a *= 1.0 + max(0.0, lod) * 0.45;
              #include <alphatest_fragment>`);
        };
      }
      variant.parts.push({ geometry, material, leaves });
    });
    return variant;
  }

  /** A fresh copy of a loaded model (geometry and materials are shared). */
  spawn(name: string): THREE.Object3D {
    const m = this.models.get(name);
    if (!m) throw new Error(`model ${name} is not loaded`);
    return m.clone(true);
  }

  private disposeHole(): void {
    this.holeGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const g = o.geometry as THREE.BufferGeometry;
        if (!g.userData.shared) g.dispose();
        for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as THREE.Material[]) {
          if (!m.userData.shared) m.dispose();
        }
        if (o instanceof THREE.InstancedMesh) {
          o.customDepthMaterial?.dispose();
          o.dispose();
        }
      }
    });
    this.scene.remove(this.holeGroup);
    this.holeGroup = new THREE.Group();
    this.scene.add(this.holeGroup);
    this.floaters = [];
    this.gators.length = 0;
    this.flag = this.flagstick = this.cupLiner = null;
  }

  async buildHole(course: Course): Promise<void> {
    this.disposeHole();
    this.course = course;
    const tl = new THREE.TextureLoader();
    const [maskA, maskB] = await Promise.all([
      tl.loadAsync(assetUrl(`${course.key}_a.png`)), tl.loadAsync(assetUrl(`${course.key}_b.png`)),
    ]);
    for (const m of [maskA, maskB]) { m.colorSpace = THREE.NoColorSpace; m.anisotropy = 4; }
    this.buildTerrain(course, maskA, maskB);
    this.buildWater(course);
    this.buildTrees(course);
    this.buildProps(course);
    this.buildBackdrop(course);
    this.buildCup();
    this.setCup(course.cupX, course.cupZ, 0.054);
  }

  private buildTerrain(course: Course, maskA: THREE.Texture, maskB: THREE.Texture): void {
    const { nx, ny, step, x0, y0, heights } = course;
    const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const h = heights[k]!;
        pos[k * 3] = x0 + i * step; pos[k * 3 + 1] = h; pos[k * 3 + 2] = -(y0 + j * step);
        const hl = heights[k - (i > 0 ? 1 : 0)]!, hr = heights[k + (i < nx - 1 ? 1 : 0)]!;
        const hd = heights[k - (j > 0 ? nx : 0)]!, hu = heights[k + (j < ny - 1 ? nx : 0)]!;
        const dx = (hr - hl) / (2 * step), dy = (hu - hd) / (2 * step);
        const l = Math.hypot(dx, 1, dy);
        nor[k * 3] = -dx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = dy / l;
        uv[k * 2] = i / (nx - 1); uv[k * 2 + 1] = j / (ny - 1);
      }
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const { material, uniforms } = makeTerrainMaterial(this.terrainTex, maskA, maskB, this.buildShade(course));
    this.terrainUniforms = uniforms;
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.castShadow = this.quality !== 'low';
    this.holeGroup.add(mesh);
  }

  /** Soft baked tree shade, used where the real shadow map does not reach. One pixel per metre. */
  private buildShade(course: Course): THREE.Texture {
    const cv = document.createElement('canvas');
    cv.width = Math.round(course.x1 - course.x0);
    cv.height = Math.round(course.y1 - course.y0);
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const cot = Math.hypot(SUN_DIR.x, SUN_DIR.z) / SUN_DIR.y;
    const sx = -SUN_DIR.x / Math.hypot(SUN_DIR.x, SUN_DIR.z), sz = -SUN_DIR.z / Math.hypot(SUN_DIR.x, SUN_DIR.z);
    for (const t of course.json.trees) {
      const H = TREE_H[t[6]!]! * t[5]!;
      const reach = 0.62 * H * cot;
      const px = t[0]! + sx * reach - course.x0;
      const py = course.y1 - (t[1]! - sz * reach);
      const r = 0.4 * TREE_H[t[6]!]! * t[4]!;
      const g = ctx.createRadialGradient(px, py, r * 0.15, px, py, r);
      g.addColorStop(0, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  }

  private buildWater(course: Course): void {
    const { nx, ny, heights, waterZ } = course;
    const s = course.step < 1 ? Math.round(1 / course.step) : 1;
    const cx = Math.floor((nx - 1) / s) + 1, cy = Math.floor((ny - 1) / s) + 1;
    const vid = new Int32Array(cx * cy).fill(-1);
    const pos: number[] = [], uv: number[] = [], depth: number[] = [], flow: number[] = [];
    const dir = { x: 0, z: 0 };
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const d = waterZ - heights[j * s * nx + i * s]!;
        if (d < -0.4) continue;
        const x = course.x0 + i * s * course.step, z = -(course.y0 + j * s * course.step);
        if (!course.nearWaterBody(x, z)) continue;
        vid[j * cx + i] = pos.length / 3;
        pos.push(x, waterZ, z);
        uv.push(x / 4, -z / 4);
        depth.push(d);
        if (course.riverFlow(x, z, dir) < Infinity) {
          const sp = 0.25 + 0.9 * sstep(0, 1.6, d);
          flow.push((dir.x * sp) / 4, (-dir.z * sp) / 4);
        } else flow.push(0.012, 0.007);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < cy - 1; j++) {
      for (let i = 0; i < cx - 1; i++) {
        const a = vid[j * cx + i]!, b = vid[j * cx + i + 1]!, c = vid[(j + 1) * cx + i]!, d = vid[(j + 1) * cx + i + 1]!;
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        idx.push(a, b, c, b, d, c);
      }
    }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.016, 0.04, 0.03), roughness: 0.06, metalness: 0,
      normalMap: this.waterN, normalScale: new THREE.Vector2(0.85, 0.85), transparent: true,
    });
    mat.envMapIntensity = 0;       // reflections are done by hand below, so the banks' trees show in them
    const time = this.timeUniform;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDepth;\nattribute vec2 aFlow;\nvarying float vDepth;\nvarying vec2 vFlow;\nvarying vec3 vWaterPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDepth = aDepth;\nvFlow = aFlow;\nvWaterPos = (modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vDepth;\nvarying vec2 vFlow;\nvarying vec3 vWaterPos;')
        .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
          float shallow = smoothstep(0.0, 0.9, vDepth);
          diffuseColor.rgb = mix(vec3(0.075, 0.09, 0.05), diffuseColor.rgb, shallow);
          diffuseColor.a *= smoothstep(-0.03, 0.14, vDepth) * mix(0.7, 0.97, shallow);`)
        .replace('#include <lights_fragment_maps>', '')       // no image-based light: the mirror below replaces it
        .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
          {
            // Mirror: sky overhead, the dark tree line near the horizon. Ripples wobble the boundary, which shows the current.
            vec3 wV = normalize(cameraPosition - vWaterPos);
            vec3 wN = inverseTransformDirection(normal, viewMatrix);
            vec3 wR = reflect(-wV, wN);
            float fres = 0.025 + 0.975 * pow(1.0 - max(dot(wN, wV), 0.0), 5.0);
            vec3 skyC = mix(vec3(${HORIZON.r.toFixed(3)}, ${HORIZON.g.toFixed(3)}, ${HORIZON.b.toFixed(3)}), vec3(0.085, 0.215, 0.55), 1.0 - pow(1.0 - clamp(wR.y, 0.0, 1.0), 2.6));
            float treeLine = smoothstep(0.36, 0.14, wR.y);
            vec3 refl = mix(skyC, vec3(0.022, 0.05, 0.02), treeLine * 0.92);
            totalEmissiveRadiance += refl * fres;
            // a thin line of foam where the water meets the bank
            float foam = smoothstep(0.16, 0.02, vDepth) * smoothstep(-0.03, 0.03, vDepth);
            totalEmissiveRadiance += vec3(0.5, 0.52, 0.48) * foam * 0.5;
            diffuseColor.a = max(diffuseColor.a, fres * 0.9 * smoothstep(-0.03, 0.1, vDepth));
          }`)
        .replace('#include <normal_fragment_maps>', /* glsl */ `
          float ph0 = fract(uTime * 0.35), ph1 = fract(uTime * 0.35 + 0.5);
          float wA = 1.0 - abs(2.0 * ph0 - 1.0);
          vec2 fl = vFlow * 2.857;
          vec2 uvA = vNormalMapUv - fl * ph0;
          vec2 uvB = vNormalMapUv - fl * ph1 + vec2(0.37, 0.61);
          vec2 drift = uTime * vec2(0.011, 0.014);
          vec3 nA = texture2D(normalMap, uvA).xyz * 2.0 - 1.0 + (texture2D(normalMap, uvA * 2.7 + drift).xyz * 2.0 - 1.0) * 0.6;
          vec3 nB = texture2D(normalMap, uvB).xyz * 2.0 - 1.0 + (texture2D(normalMap, uvB * 2.7 - drift).xyz * 2.0 - 1.0) * 0.6;
          vec3 mapN = mix(nB, nA, wA);
          mapN.xy *= normalScale;
          normal = normalize(tbn * normalize(mapN));`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    this.holeGroup.add(mesh);
  }

  private buildTrees(course: Course): void {
    const CELL = 64;
    const buckets = new Map<string, number[][]>();
    for (const t of course.json.trees) {
      const key = `${Math.floor(t[0]! / CELL)}_${Math.floor(t[1]! / CELL)}_${t[6]}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(t);
    }
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), qt = new THREE.Quaternion(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const list of buckets.values()) {
      const variant = this.trees[list[0]![6]!]!;
      for (const part of variant.parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((t, i) => {
          p.set(t[0]!, t[2]!, -t[1]!);
          qt.setFromAxisAngle(up, t[3]!);
          sc.set(t[4]!, t[5]!, t[4]!);
          im.setMatrixAt(i, m.compose(p, qt, sc));
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.computeBoundingBox();
        im.castShadow = true;
        im.receiveShadow = true;
        if (part.leaves) {
          const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.4, map: (part.material as THREE.MeshStandardMaterial).map });
          dm.userData.shared = false;
          im.customDepthMaterial = dm;
        }
        this.holeGroup.add(im);
      }
    }
  }

  private buildProps(course: Course): void {
    for (const pr of course.json.props) {
      const name = pr.kind === 'log' ? `log_${pr.seed ?? 1}` : pr.kind;
      if (!this.models.has(name)) continue;
      const o = this.spawn(name);
      o.position.set(pr.x, pr.z, -pr.y);
      o.rotation.y = (pr.yaw * Math.PI) / 180;
      this.holeGroup.add(o);
      if (pr.float) {
        const gator = pr.kind === 'gator';
        this.floaters.push({ obj: o, y: pr.z, phase: pr.x * 0.7 + pr.y * 0.13, yaw: o.rotation.y, gator, snap: 0 });
        if (gator) this.gators.push({ x: pr.x, z: -pr.y, yaw: o.rotation.y });
      }
    }
    this.flagstick = this.spawn('flagstick');
    this.flagstick.traverse((o) => { if (o.name.endsWith('_Flag')) this.flag = o; });
    this.holeGroup.add(this.flagstick);
  }

  private buildBackdrop(course: Course): void {
    const n = 80, span = 4200;
    const cxm = (course.x0 + course.x1) / 2, czm = -(course.y0 + course.y1) / 2;
    const W = course.x1 - course.x0, H = course.y1 - course.y0;
    const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
    const seed = course.key === 'h7' ? 3 : 9;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // denser rings near the course, so the join under the rim is tidy
        const u = (i / (n - 1)) * 2 - 1, v = (j / (n - 1)) * 2 - 1;
        const X = Math.sign(u) * Math.pow(Math.abs(u), 1.8) * span * 0.5, Z = Math.sign(v) * Math.pow(Math.abs(v), 1.8) * span * 0.5;
        const r = Math.max(Math.abs(X) / W, Math.abs(Z) / H) * 2 * 180;
        const f = fbm(X / 800 + 5, Z / 800 + 5, seed);
        // well below the course inside its bounds, rising to rim height just outside them
        const y = -9 + 17.5 * sstep(174, 188, r) + sstep(200, 1500, r) * (40 + 95 * f) + 9 * (fbm(X / 280, Z / 280, seed + 5) - 0.5) * sstep(170, 420, r);
        const k = (j * n + i) * 3;
        pos[k] = X + cxm; pos[k + 1] = y; pos[k + 2] = Z + czm;
        const g = fbm(X / 180, Z / 180, seed + 9);
        const field = sstep(0.42, 0.56, fbm(X / 450 + 3, Z / 450, seed + 14));
        let cr = 0.06 * (1 + 0.5 * g), cg = 0.105 * (1 + 0.5 * g), cb = 0.04 * (1 + 0.5 * g);
        cr = cr * (1 - field) + 0.17 * field; cg = cg * (1 - field) + 0.24 * field; cb = cb * (1 - field) + 0.08 * field;
        col[k] = cr; col[k + 1] = cg; col[k + 2] = cb;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    mesh.receiveShadow = false;
    this.holeGroup.add(mesh);
  }

  private buildCup(): void {
    const g = new THREE.Group();
    const soil = new THREE.MeshStandardMaterial({ color: 0x1a130c, roughness: 1, side: THREE.BackSide });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.12, 28, 1, true), soil);
    wall.position.y = -0.06;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 28), new THREE.MeshStandardMaterial({ color: 0x0c0a08, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.12;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 6, 32), new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.5 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.012;
    g.add(wall, floor, rim);
    this.cupLiner = g;
    this.holeGroup.add(g);
  }

  /** Move the hole and pin. r is the cup radius in metres (0.054 is regulation). */
  setCup(x: number, z: number, r: number): void {
    if (!this.course) return;
    const y = this.course.terrainAt(x, z);
    this.terrainUniforms?.uCup.value.set(x, z, r);
    this.flagstick?.position.set(x, y, z);
    if (this.cupLiner) {
      this.cupLiner.position.set(x, y, z);
      this.cupLiner.scale.set(r, 1, r);
      this.cupLiner.visible = r > 0.06;
    }
  }

  setGreenWet(w: number): void {
    if (this.terrainUniforms) this.terrainUniforms.uWet.value = w;
  }

  /** The alligator nearest a point lunges. */
  gatorSnap(x: number, z: number): void {
    let best: Floater | null = null, bd = Infinity;
    for (const f of this.floaters) {
      if (!f.gator) continue;
      const d = Math.hypot(f.obj.position.x - x, f.obj.position.z - z);
      if (d < bd) { bd = d; best = f; }
    }
    if (best) best.snap = 1;
  }

  update(dt: number, time: number, focus: THREE.Vector3): void {
    this.timeUniform.value = time;
    this.skyUniforms.uTime.value = time;
    this.sky.position.copy(this.camera.position);

    // Shadow box follows the action, snapped to whole texels so the edges do not crawl.
    const texel = (SHADOW_R * 2) / this.sun.shadow.mapSize.x;
    this.shadowFocus.set(Math.round(focus.x / texel / 8) * texel * 8, 0, Math.round(focus.z / texel / 8) * texel * 8);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(SUN_DIR, 320);
    this.terrainUniforms?.uShadow.value.set(this.shadowFocus.x, this.shadowFocus.z, SHADOW_R);

    for (const f of this.floaters) {
      const o = f.obj;
      o.position.y = f.y + Math.sin(time * 0.9 + f.phase) * 0.035;
      if (f.gator) {
        f.snap = Math.max(0, f.snap - dt * 1.6);
        const k = Math.sin(Math.min(1, f.snap) * Math.PI);
        o.rotation.set(-0.5 * k, f.yaw + Math.sin(time * 0.35 + f.phase) * 0.06, 0);
        o.position.y += 0.25 * k;
      } else {
        o.rotation.z = Math.sin(time * 0.6 + f.phase) * 0.05;
      }
    }
    if (this.flag) {
      const w = this.wind;
      const sp = Math.hypot(w.x, w.z);
      const head = sp > 0.2 ? Math.atan2(-w.z, w.x) : 0.6;
      this.flag.rotation.y = head + Math.sin(time * (2.2 + sp * 0.5)) * (0.1 + 0.03 * sp) + Math.sin(time * 5.3) * 0.04;
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
