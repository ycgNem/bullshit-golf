import * as THREE from 'three';

export interface TerrainTextures {
  roughC: THREE.Texture; roughN: THREE.Texture;
  fairC: THREE.Texture; fairN: THREE.Texture;
  greenC: THREE.Texture; greenN: THREE.Texture;
  sandC: THREE.Texture; sandN: THREE.Texture;
  pathC: THREE.Texture;
}

export interface TerrainUniforms {
  /** cup centre x, z and radius: fragments inside are discarded, so the hole can move at runtime */
  uCup: { value: THREE.Vector3 };
  /** centre x, z of the real shadow map and its radius; baked tree shade takes over beyond it */
  uShadow: { value: THREE.Vector3 };
  /** multiplies turf colour on the green (sprinklers darken it) */
  uWet: { value: number };
}

/**
 * Splat material for the course. Same recipe as the Blender terrain: mask A = fairway / green / sand,
 * mask B = path / mowing stripe (0.5 neutral) / macro tone; detail textures are mapped in metres.
 */
export function makeTerrainMaterial(
  tex: TerrainTextures, maskA: THREE.Texture, maskB: THREE.Texture, shade: THREE.Texture,
): { material: THREE.MeshStandardMaterial; uniforms: TerrainUniforms } {
  const uniforms: TerrainUniforms = {
    uCup: { value: new THREE.Vector3(0, 0, 0.054) },
    uShadow: { value: new THREE.Vector3(0, 0, 100) },
    uWet: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  material.envMapIntensity = 0.55;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      tMaskA: { value: maskA }, tMaskB: { value: maskB }, tShade: { value: shade },
      tRoughC: { value: tex.roughC }, tRoughN: { value: tex.roughN },
      tFairC: { value: tex.fairC }, tFairN: { value: tex.fairN },
      tGreenC: { value: tex.greenC }, tGreenN: { value: tex.greenN },
      tSandC: { value: tex.sandC }, tSandN: { value: tex.sandN },
      tPathC: { value: tex.pathC },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec2 vMaskUv;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvMaskUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D tMaskA, tMaskB, tShade, tRoughC, tRoughN, tFairC, tFairN, tGreenC, tGreenN, tSandC, tSandN, tPathC;
        uniform vec3 uCup;
        uniform vec3 uShadow;
        uniform float uWet;
        varying vec3 vWPos;
        varying vec2 vMaskUv;
        vec3 gTerrainN;
        float gTerrainRough;`)
      .replace('#include <map_fragment>', /* glsl */ `
        if (distance(vWPos.xz, uCup.xy) < uCup.z) discard;
        vec2 wuv = vec2(vWPos.x, -vWPos.z);
        vec3 mA = texture2D(tMaskA, vMaskUv).rgb;
        vec3 mB = texture2D(tMaskB, vMaskUv).rgb;
        vec3 cR = texture2D(tRoughC, wuv / 3.0).rgb;
        cR = mix(cR, texture2D(tRoughC, mat2(0.6216, 0.7833, -0.7833, 0.6216) * wuv / 7.3).rgb, 0.45);
        vec3 cF = texture2D(tFairC, wuv / 2.0).rgb;
        cF = mix(cF, texture2D(tFairC, mat2(0.8253, 0.5646, -0.5646, 0.8253) * wuv / 5.1).rgb, 0.4);
        vec3 cG = texture2D(tGreenC, wuv).rgb * (1.0 - 0.22 * uWet);
        vec3 cS = texture2D(tSandC, wuv / 2.0).rgb;
        vec3 cP = texture2D(tPathC, wuv / 4.0).rgb;
        vec3 tcol = mix(mix(mix(mix(cR, cF, mA.r), cG, mA.g), cS, mA.b), cP, mB.r);
        tcol *= mix(vec3(0.80, 0.78, 0.62), vec3(1.10, 1.13, 1.08), mB.b);
        tcol *= mix(0.72, 1.28, mB.g);
        float sFar = smoothstep(uShadow.z * 0.7, uShadow.z * 0.95, distance(vWPos.xz, uShadow.xy));
        tcol *= mix(1.0, texture2D(tShade, vMaskUv).r, 0.25 + 0.75 * sFar);
        diffuseColor.rgb *= tcol;
        vec3 nR = texture2D(tRoughN, wuv / 3.0).xyz * 2.0 - 1.0;
        vec3 nF = texture2D(tFairN, wuv / 2.0).xyz * 2.0 - 1.0;
        vec3 nG = texture2D(tGreenN, wuv).xyz * 2.0 - 1.0;
        vec3 nS = texture2D(tSandN, wuv / 2.0).xyz * 2.0 - 1.0;
        vec3 nT = mix(mix(mix(nR * vec3(1.4, 1.4, 1.0), nF, mA.r), nG * vec3(0.6, 0.6, 1.0), mA.g), nS * vec3(1.5, 1.5, 1.0), mA.b);
        nT = mix(nT, vec3(0.0, 0.0, 1.0), mB.r * 0.8);
        float nearK = 1.0 - smoothstep(30.0, 140.0, length(vViewPosition));
        gTerrainN = normalize(vec3(nT.xy * (0.25 + 0.75 * nearK), max(nT.z, 0.2)));
        gTerrainRough = mix(mix(mix(mix(0.96, 0.88, mA.r), 0.82 - 0.3 * uWet, mA.g), 0.97, mA.b), 0.8, mB.r);`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gTerrainRough;')
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        {
          vec3 tX = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
          vec3 tT = normalize(tX - normal * dot(tX, normal));
          vec3 tB = cross(normal, tT);
          normal = normalize(tT * gTerrainN.x + tB * gTerrainN.y + normal * gTerrainN.z);
        }`);
  };
  return { material, uniforms };
}
