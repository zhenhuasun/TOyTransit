import * as THREE from 'three';
import { BUILDING_STRIDE, type CityId } from '../../shared/types.ts';
import { groundUniforms } from './island.ts';
import { rng } from './raster.ts';
import { OCCLUDER_STENCIL } from './stockModel.ts';
import { LOOK_PARS, lookUniforms, applyToon } from '../themes/look.ts';
import type { FrameInfo, Layer } from './world.ts';

const PALETTES: Record<CityId, string[]> = {
  toronto: ['#c98a6e', '#e8c9a8', '#d9b8a5', '#f1e6d2', '#b8c4cc', '#e4d9c6', '#a8705e', '#f3e2b8'],
};
// Roofs: most cities get a pale version of the wall; some have a signature roofscape.
const ROOFS: Partial<Record<CityId, { color: string; mix: number }>> = {};
const GLASS = ['#9fd3e8', '#a9c6e8', '#b5e2dc', '#c1cfe6', '#8ec2d9'];
const H_SCALE = 0.55;

export class Buildings implements Layer {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private material: THREE.MeshLambertMaterial;

  constructor(city: CityId, data: Int16Array, tracks: ArrayLike<number>[] = [], clearings: [number, number, number][] = []) {
    const n = Math.floor(data.length / BUILDING_STRIDE);
    const clearTrack = trackClearance(tracks, 26);
    const clear = (x: number, y: number, r: number) => clearTrack(x, y, r) || clearings.some(([cx, cy, cr]) => Math.hypot(x - cx, y - cy) < cr + r);
    const rand = rng(4242);
    const pal = PALETTES[city].map((c) => new THREE.Color(c));
    const glass = GLASS.map((c) => new THREE.Color(c));
    this.material = makeMaterial(city);
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const depthMat = voxelDepthMaterial();

    const CELL = 2200;
    const cells = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const o = i * BUILDING_STRIDE;
      const cx = data[o] * 2;
      const cy = data[o + 1] * 2;
      // Keep rail corridors open so trains stay visible between the blocks.
      if (clear(cx, cy, Math.hypot(data[o + 2], data[o + 3]) / 4)) continue;
      const k = `${Math.floor(cx / CELL)},${Math.floor(cy / CELL)}`;
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(i);
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const towers: THREE.Matrix4[] = [];
    for (const list of cells.values()) {
      const mesh = new THREE.InstancedMesh(geo, this.material, list.length);
      list.forEach((i, j) => {
        const o = i * BUILDING_STRIDE;
        const cx = data[o] * 2;
        const cy = data[o + 1] * 2;
        const w = Math.max(3, data[o + 2] / 2);
        const d = Math.max(3, data[o + 3] / 2);
        const ang = data[o + 4] / 10000;
        const hReal = Math.max(4, data[o + 5] / 2);
        // OSM often has overlapping or duplicate footprints (a building and its parts). A per-building
        // jitter in height and footprint keeps their roofs and walls from sharing a plane and flickering.
        const jit = hash(i);
        const h = hReal * H_SCALE + jit * 0.6;
        const k = 0.95 + jit * 0.025;
        q.setFromAxisAngle(up, ang);
        m4.compose(new THREE.Vector3(cx, 0, -cy), q, new THREE.Vector3(w * k, h, d * k));
        mesh.setMatrixAt(j, m4);
        const tall = hReal > 90;
        const c = (tall ? glass : pal)[Math.floor(rand() * (tall ? glass.length : pal.length))].clone();
        c.offsetHSL(0, 0, (rand() - 0.5) * 0.05);
        mesh.setColorAt(j, c);
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMat;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    if (towers.length) this.group.add(waterTowers(towers));
  }

  update(f: FrameInfo) {
    const cast = f.mpp < 7;
    for (const m of this.meshes) m.castShadow = cast;
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.material.dispose();
  }
}

/** A stable pseudo-random number in [0, 1) for an index. */
const hash = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Returns a test: is a building (center, radius) within `dist` meters of any track polyline? */
export function trackClearance(tracks: ArrayLike<number>[], dist: number) {
  const CELL = 64;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  for (const pts of tracks) {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i];
      const ay = pts[i + 1];
      const bx = pts[i + 2];
      const by = pts[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len / 8));
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((bx - ax) * k) / steps;
        const y = ay + ((by - ay) * k) / steps;
        const kk = key(Math.floor(x / CELL), Math.floor(y / CELL));
        let list = grid.get(kk);
        if (!list) grid.set(kk, (list = []));
        list.push(x, y);
      }
    }
  }
  return (x: number, y: number, r: number) => {
    const d = dist + r;
    const i0 = Math.floor((x - d) / CELL);
    const i1 = Math.floor((x + d) / CELL);
    const j0 = Math.floor((y - d) / CELL);
    const j1 = Math.floor((y + d) / CELL);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) if (Math.hypot(list[k] - x, list[k + 1] - y) < d) return true;
      }
    return false;
  };
}

/** Voxel snapping for instanced boxes: axis-aligned, whole voxels, on the world grid (identity when off). */
export const VOXEL_SNAP_GLSL = /* glsl */ `
mat4 lkSnap(mat4 m) {
  float V = uLk_voxel;
  if (V < 0.8) return m;
  // Sizes step to whole blocks; each box keeps its own orientation and position. A small per-box nudge keeps
  // neighbors that round to the same size from sharing a wall or roof plane (z-fighting).
  vec3 sc = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  vec3 s = max(vec3(V), floor(sc / V + 0.5) * V);
  float j = fract(sin(dot(m[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  s += vec3(0.12, 0.3, 0.12) * j;
  return mat4(vec4(m[0].xyz * (s.x / sc.x), 0.0), vec4(m[1].xyz * (s.y / sc.y), 0.0), vec4(m[2].xyz * (s.z / sc.z), 0.0), m[3]);
}
`;

function makeMaterial(city: CityId) {
  const m = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  const roof = ROOFS[city];
  const rc = new THREE.Color(roof?.color ?? '#ffffff');
  const roofGlsl = roof
    ? `roofCol = mix(mix(wall, vec3(1.0), 0.2), vec3(${rc.r.toFixed(3)}, ${rc.g.toFixed(3)}, ${rc.b.toFixed(3)}), ${roof.mix.toFixed(2)} * step(vHeight, 70.0));`
    : 'roofCol = mix(wall, vec3(1.0), 0.28);';
  // Mark visible building pixels in the stencil so trains behind them can be x-rayed.
  Object.assign(m, OCCLUDER_STENCIL);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, groundUniforms, lookUniforms);
    applyToon(sh);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${LOOK_PARS}\n${VOXEL_SNAP_GLSL}\nvarying vec2 vFacade;\nvarying float vRoof;\nvarying float vNx;\nvarying float vSeed;\nvarying float vHeight;\nvarying vec3 vLocal;\nvarying vec3 vScale;`,
      )
      .replace('#include <beginnormal_vertex>', 'mat4 bim = lkSnap(instanceMatrix);\n#define instanceMatrix bim\n#include <beginnormal_vertex>')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 sc = vec3(length(bim[0].xyz), length(bim[1].xyz), length(bim[2].xyz));
        float along = abs(normal.x) > 0.5 ? position.z * sc.z : position.x * sc.x;
        vFacade = vec2(along, position.y * sc.y);
        vRoof = normal.y;
        vNx = normal.x;
        vHeight = sc.y;
        vLocal = position;
        vScale = sc;
        vSeed = fract(sin(dot(bim[3].xz, vec2(12.9898, 78.233))) * 43758.5453);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vFacade; varying float vRoof; varying float vNx; varying float vSeed; varying float vHeight; varying vec3 vLocal; varying vec3 vScale;
        uniform float uNight; uniform float uMpp;
        ${LOOK_PARS}
        float bh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 wall = mix(diffuseColor.rgb, uLk_bTint * (0.95 + 0.1 * vSeed), uLk_bTintK);
        // Cartoon palette (cel): each building takes one of a few bold flat colors, chosen by its seed.
        if (uLk_bPop > 0.001) {
          float pk = floor(vSeed * 7.0);
          vec3 pc = pk < 1.0 ? vec3(1.0, 0.42, 0.28) : pk < 2.0 ? vec3(1.0, 0.78, 0.25) : pk < 3.0 ? vec3(0.36, 0.78, 0.92)
                  : pk < 4.0 ? vec3(0.62, 0.86, 0.42) : pk < 5.0 ? vec3(0.95, 0.5, 0.55) : pk < 6.0 ? vec3(0.72, 0.6, 0.9) : vec3(0.97, 0.95, 0.9);
          wall = mix(wall, pc * pc, uLk_bPop);
        }
        float lit = 0.0;
        vec3 litCol = uLk_bLitCol;
        float V = uLk_voxel;
        bool vox = V > 0.8;
        if (vRoof > 0.5) {
          vec3 roofCol;
          ${roofGlsl}
          diffuseColor.rgb = mix(roofCol, uLk_bRoof * (0.96 + 0.08 * vSeed), uLk_bRoofK);
        } else if (vRoof > -0.5) {
          bool tall = vHeight > 70.0;
          vec2 cell = vox ? vec2(V * 0.5) : tall ? vec2(3.2, 3.2) : vec2(4.6, 3.0);
          // Facade coordinates measured from the wall's left edge, so voxel windows line up with voxel seams.
          vec2 wallUV = vec2(abs(vNx) > 0.5 ? (vLocal.z + 0.5) * vScale.z : (vLocal.x + 0.5) * vScale.x, vFacade.y);
          vec2 g = (vox ? wallUV : vFacade) / cell;
          vec2 fr = fract(g);
          float win = step(0.26, fr.x) * step(fr.x, 0.74) * step(0.28, fr.y) * step(fr.y, 0.8);
          if (tall && !vox) win = step(0.12, fr.x) * step(fr.x, 0.88) * step(0.2, fr.y) * step(fr.y, 0.84);
          win *= step(2.2, vFacade.y) * step(vFacade.y, vHeight - 1.2);
          float fade = 1.0 - smoothstep(1.4, 4.0, uMpp);
          vec2 id = floor(g) + vSeed * 91.0;
          float on = step(1.0 - uLk_bLit * (0.5 - 0.25 * (1.0 - uNight)), bh(id));
          // Two-tone night windows when the look asks for it (neon: its window color and its coast color).
          litCol = mix(uLk_bLitCol, uLk_coastGlow, step(0.5, bh(id + 7.7)) * step(0.01, uLk_coastGlowK));
          vec3 glassCol = mix(wall, vec3(0.32, 0.43, 0.58), 0.55);
          diffuseColor.rgb = mix(wall, glassCol, win * fade * uLk_bWin);
          // Base shading: a darker plinth line and a soft ground AO.
          diffuseColor.rgb *= 0.86 + 0.14 * smoothstep(0.0, 6.0, vFacade.y);
          lit = mix(0.5 * step(3.0, vFacade.y) * uLk_bLit, win * on, fade);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.6, 0.85), uNight * 0.6 * uLk_nightK);
        }
        // Voxel blocks: seams every voxel and a little per-block color, fading once blocks get small.
        if (vox) {
          vec2 vf = (vRoof > 0.5 ? (vLocal.xz + 0.5) * vScale.xz : vec2(abs(vNx) > 0.5 ? (vLocal.z + 0.5) * vScale.z : (vLocal.x + 0.5) * vScale.x, vFacade.y)) / V;
          vec2 vq = fract(vf);
          float vpx = V / max(uMpp, 1e-3);
          float vshow = smoothstep(4.0, 10.0, vpx);
          float ve = min(min(vq.x, 1.0 - vq.x), min(vq.y, 1.0 - vq.y)) * vpx;
          diffuseColor.rgb *= 1.0 + vshow * (0.06 * (bh(floor(vf) + vSeed * 13.0) - 0.5) - 0.12 * (1.0 - smoothstep(0.3, 1.2, ve)));
        }
        diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, uLk_bSat);
        // Silhouette edges, drawn here rather than by a screen filter so they stay crisp and quiet: they fade
        // out once a building is only a few pixels across.
        if (uLk_bEdgeK > 0.001) {
          vec3 q = vec3((0.5 - abs(vLocal.x)) * vScale.x, min(vLocal.y, 1.0 - vLocal.y) * vScale.y, (0.5 - abs(vLocal.z)) * vScale.z);
          float ed = vRoof > 0.5 ? min(q.x, q.z) : abs(vNx) > 0.5 ? min(q.z, q.y) : min(q.x, q.y);
          float epx = ed / max(fwidth(ed), 1e-4);
          float edge = 1.0 - smoothstep(uLk_bEdgePx * 0.6, uLk_bEdgePx * 1.1, epx);
          edge *= smoothstep(6.0, 16.0, min(vScale.x, vScale.z) / max(uMpp, 1e-3)) * uLk_bEdgeK;
          diffuseColor.rgb = mix(diffuseColor.rgb, uLk_bEdge, edge);
          lit = max(lit, edge * uLk_lineGlow * 0.6);
          if (edge * uLk_lineGlow > 0.01) litCol = mix(litCol, uLk_bEdge, edge);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += litCol * lit * max(uNight, uLk_lineGlow) * 0.95 * uLk_bLitK;`,
      );
  };
  // The shader text differs per city (roof colors), so programs must not be shared between cities.
  m.customProgramCacheKey = () => `buildings-${city}`;
  return m;
}

/** Shadow casting for voxel-snapped boxes (the default depth material would cast the unsnapped shapes). */
export function voxelDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, lookUniforms);
    applyToon(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${LOOK_PARS}\n${VOXEL_SNAP_GLSL}`)
      .replace('#include <begin_vertex>', 'mat4 bim = lkSnap(instanceMatrix);\n#define instanceMatrix bim\n#include <begin_vertex>');
  };
  m.customProgramCacheKey = () => 'voxel-depth';
  return m;
}

function waterTowers(list: THREE.Matrix4[]) {
  // A barrel on stilts with a witch's-hat roof.
  const barrel = new THREE.CylinderGeometry(2.1, 2.1, 4, 10).translate(0, 4.6, 0);
  const roof = new THREE.ConeGeometry(2.4, 1.8, 10).translate(0, 7.5, 0);
  const legs = [-1, 1].flatMap((a) => [-1, 1].map((b) => new THREE.BoxGeometry(0.3, 2.6, 0.3).translate(a * 1.3, 1.3, b * 1.3)));
  const parts = [barrel, roof, ...legs].map((g) => g.toNonIndexed());
  const colors = [new THREE.Color('#9b6a45'), new THREE.Color('#6f4b33'), ...legs.map(() => new THREE.Color('#4a4a4a'))];
  const pos: number[] = [];
  const col: number[] = [];
  parts.forEach((g, i) => {
    const p = g.getAttribute('position').array;
    for (let k = 0; k < p.length; k += 3) {
      pos.push(p[k], p[k + 1], p[k + 2]);
      col.push(colors[i].r, colors[i].g, colors[i].b);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), list.length);
  list.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  return mesh;
}
