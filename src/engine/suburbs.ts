import * as THREE from 'three';
import { LOOK_PARS, lookUniforms, applyToon } from '../themes/look.ts';
import type { CityId, GeoData } from '../../shared/types.ts';
import { groundUniforms } from './island.ts';
import { makeGrid, rasterize, rng, sampleMask, type Grid } from './raster.ts';
import type { FrameInfo, Layer } from './world.ts';
import { LOW } from './quality.ts';
import { trackClearance, VOXEL_SNAP_GLSL, voxelDepthMaterial } from './buildings.ts';

// Outside the detailed building extract, fill the land with procedural toy houses. Density follows
// the real street network (lots of roads = lots of homes), and houses line up with the nearest road.

const ROOFS: Record<CityId, string[]> = {
  toronto: ['#a8705e', '#8f7a78', '#b98068', '#7f8894', '#c9957a'],
};
/** Walls for taller, flat-roofed blocks (apartments, mid-rise). */
const BLOCKS: Record<CityId, string[]> = {
  toronto: ['#c98a6a', '#e2cdb2', '#d6b394', '#b8c4cc', '#efe6d6'],
};
const WALLS: Record<CityId, string[]> = {
  toronto: ['#f3e2c8', '#e9cdb0', '#f6ecd9', '#e3d3c6', '#d9e3ea'],
};

interface Raster {
  w: number;
  h: number;
  minX: number;
  maxY: number;
  cell: number;
  cov: Uint8Array;
  hgt: Uint8Array;
  ang: Uint8Array | null;
}

const NEAR_MPP = 2.6;
const TILE = 1200;

export class Suburbs implements Layer {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private far = new THREE.Group();
  private near = new THREE.Group();
  private raster: Raster | null = null;
  private grid!: Grid;
  private blocked!: Uint8Array;
  private core!: Uint8Array;
  private walls: THREE.Color[] = [];
  private roofs: THREE.Color[] = [];
  private tiles = new Map<string, { group: THREE.Group; used: number }>();
  private geoBody = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private geoRoof: THREE.BufferGeometry;
  private bodyMat = windowMaterial();
  private roofMat = roofMaterial();
  private depthMat = voxelDepthMaterial();
  private roofMeshes: THREE.InstancedMesh[] = [];
  private roofsShown = true;
  private frame = 0;

  private blocks: THREE.Color[] = [];
  private clear: (x: number, y: number, r: number) => boolean = () => false;

  constructor(city: CityId, geo: GeoData, coreBuildings: Int16Array | null, density: ArrayBuffer | null = null, tracks: ArrayLike<number>[] = []) {
    this.clear = trackClearance(tracks, 24);
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-0.55, 0);
    roofShape.lineTo(0.55, 0);
    roofShape.lineTo(0, 0.42);
    roofShape.closePath();
    // Gable with its base at y = 0 and the ridge along x.
    this.geoRoof = new THREE.ExtrudeGeometry(roofShape, { depth: 1.04, bevelEnabled: false }).translate(0, 0, -0.52).rotateY(Math.PI / 2);
    this.group.add(this.far, this.near);
    const b = geo.bounds;
    const grid = makeGrid(b, 1400);
    const blocked = rasterize(grid, [...geo.water, ...(geo.parks ?? []), ...(geo.airports ?? []), ...(geo.green ?? [])]);
    // Road density field: count road length per cell, blurred; plus road direction per cell.
    const W = grid.w;
    const H = grid.h;
    const dens = new Float32Array(W * H);
    const dirX = new Float32Array(W * H);
    const dirY = new Float32Array(W * H);
    for (const r of geo.roads) {
      const w = r.k === 0 ? 0.3 : r.k === 1 ? 0.8 : 1;
      for (let i = 0; i + 3 < r.pts.length; i += 2) {
        const ax = r.pts[i];
        const ay = r.pts[i + 1];
        const bx = r.pts[i + 2];
        const by = r.pts[i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1) continue;
        const steps = Math.ceil(len / grid.cell);
        // Direction doubled-angle so opposite directions reinforce.
        const a = Math.atan2(by - ay, bx - ax) * 2;
        for (let k = 0; k <= steps; k++) {
          const x = ax + ((bx - ax) * k) / steps;
          const y = ay + ((by - ay) * k) / steps;
          const ci = Math.floor((x - grid.minX) / grid.cell);
          const cj = Math.floor((grid.maxY - y) / grid.cell);
          if (ci < 0 || cj < 0 || ci >= W || cj >= H) continue;
          const idx = cj * W + ci;
          dens[idx] += (w * len) / steps;
          dirX[idx] += Math.cos(a) * w;
          dirY[idx] += Math.sin(a) * w;
        }
      }
    }
    const blurred = blur(dens, W, H, 2);
    // Core areas already have real buildings: mark them so we don't double up.
    const core = new Uint8Array(W * H);
    if (coreBuildings) {
      for (let i = 0; i < coreBuildings.length; i += 6) {
        const x = coreBuildings[i] * 2;
        const y = coreBuildings[i + 1] * 2;
        const ci = Math.floor((x - grid.minX) / grid.cell);
        const cj = Math.floor((grid.maxY - y) / grid.cell);
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = ci + di;
            const jj = cj + dj;
            if (ii >= 0 && jj >= 0 && ii < W && jj < H) core[jj * W + ii] = 1;
          }
      }
    }
    const roofs = ROOFS[city].map((c) => new THREE.Color(c));
    const walls = WALLS[city].map((c) => new THREE.Color(c));
    const rand = rng(31337);
    this.grid = grid;
    this.blocked = blocked;
    this.core = core;
    this.walls = walls;
    this.roofs = roofs;
    this.blocks = BLOCKS[city].map((c) => new THREE.Color(c));
    if (density && density.byteLength > 20) {
      this.raster = parseRaster(density);
      this.build(this.generate(rand, null, LOW ? 30000 : 90000), this.far);
      return;
    }
    const cellArea = grid.cell * grid.cell;
    // Two scales: the wide field says "this is town" (even where only arterials are mapped),
    // the local field adds density along busy streets.
    const wide = blur(dens, W, H, 9);
    const want = new Float32Array(W * H);
    let total = 0;
    for (let idx = 0; idx < W * H; idx++) {
      if (blocked[idx] || core[idx]) continue;
      const town = THREE.MathUtils.clamp((wide[idx] / cellArea - 0.0011) * 420, 0, 1);
      const street = THREE.MathUtils.clamp((blurred[idx] / cellArea - 0.004) * 60, 0, 0.5);
      const v = town * (0.75 + street);
      want[idx] = v;
      total += v;
    }
    const MAX = LOW ? 25000 : 80000;
    const k = Math.min(1, MAX / Math.max(1, total));
    const items: Item[] = [];
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const idx = j * W + i;
        const v = want[idx] * k;
        if (v <= 0) continue;
        let n = Math.floor(v) + (rand() < v % 1 ? 1 : 0);
        if (!n) continue;
        // Align with the dominant street direction nearby (sampled a little wider for stability).
        let dx = 0;
        let dy = 0;
        for (let dj = -2; dj <= 2; dj++)
          for (let di = -2; di <= 2; di++) {
            const ii = Math.min(W - 1, Math.max(0, i + di));
            const jj = Math.min(H - 1, Math.max(0, j + dj));
            dx += dirX[jj * W + ii];
            dy += dirY[jj * W + ii];
          }
        const ang = Math.atan2(dy, dx) / 2;
        while (n--) {
          const x = grid.minX + (i + rand()) * grid.cell;
          const y = grid.maxY - (j + rand()) * grid.cell;
          if (sampleMask(grid, blocked, x, y)) continue;
          const big = rand() < 0.12;
          items.push({
            x,
            y,
            w: big ? 16 + rand() * 18 : 8 + rand() * 6,
            d: big ? 12 + rand() * 12 : 7 + rand() * 4,
            h: big ? 10 + rand() * 16 : 6 + rand() * 5,
            a: ang + (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.08,
            wall: walls[Math.floor(rand() * walls.length)],
            roof: roofs[Math.floor(rand() * roofs.length)],
            flat: big,
          });
        }
      }
    }
    this.build(items, this.far);
  }

  private generate(rand: () => number, box: [number, number, number, number] | null, budget: number) {
    const items = fromDensity(this.raster!, this.grid, this.blocked, this.core, this.walls, this.roofs, rand, box, budget);
    const out: Item[] = [];
    for (const it of items) {
      if (this.clear(it.x, it.y, Math.max(it.w, it.d) / 2)) continue;
      if (it.flat) it.wall = this.blocks[Math.floor(rand() * this.blocks.length)];
      out.push(it);
    }
    return out;
  }

  private build(items: Item[], into: THREE.Group, cellSize = 3000) {
    // A house: box body (wall color) + gabled roof (roof color); flat roofs on taller blocks.
    const body = this.geoBody;
    const roof = this.geoRoof;
    const bodyMat = this.bodyMat;
    const roofMat = this.roofMat;
    const CELL = cellSize;
    const cells = new Map<string, typeof items>();
    for (const it of items) {
      const k = `${Math.floor(it.x / CELL)},${Math.floor(it.y / CELL)}`;
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(it);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const list of cells.values()) {
      const pitched = list.filter((it) => !it.flat);
      const b = new THREE.InstancedMesh(body, bodyMat, list.length);
      const r = new THREE.InstancedMesh(roof, roofMat, Math.max(1, pitched.length));
      r.count = pitched.length;
      let ri = 0;
      list.forEach((it, i) => {
        q.setFromAxisAngle(up, it.a);
        m.compose(new THREE.Vector3(it.x, 0.4, -it.y), q, new THREE.Vector3(it.w, it.h, it.d));
        b.setMatrixAt(i, m);
        b.setColorAt(i, it.wall);
        if (!it.flat) {
          m.compose(new THREE.Vector3(it.x, 0.4 + it.h, -it.y), q, new THREE.Vector3(it.w, Math.min(it.w, it.d) * 0.9, it.d));
          r.setMatrixAt(ri, m);
          r.setColorAt(ri, it.roof);
          ri++;
        }
      });
      b.customDepthMaterial = this.depthMat;
      r.visible = this.roofsShown;
      this.roofMeshes.push(r);
      for (const mesh of [b, r]) {
        mesh.computeBoundingSphere();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.meshes.push(mesh);
        into.add(mesh);
      }
    }
  }

  /** Pitched roofs on or off (the voxel style turns every house into a block). */
  setRoofs(on: boolean) {
    this.roofsShown = on;
    for (const r of this.roofMeshes) r.visible = on;
  }

  update(f: FrameInfo) {
    const show = f.mpp < 16;
    const nearOn = !!this.raster && f.mpp < NEAR_MPP;
    this.far.visible = show && !nearOn;
    this.near.visible = nearOn;
    for (const m of this.meshes) m.castShadow = f.mpp < 5;
    if (!nearOn || ++this.frame % 6) return;
    // Full-density tiles around the focus, nearest first.
    const R = Math.min(f.radius, LOW ? 2600 : 4200);
    const fx = f.focus.x;
    const fy = -f.focus.z;
    const want: [string, number, number, number][] = [];
    for (let tx = Math.floor((fx - R) / TILE); tx <= Math.floor((fx + R) / TILE); tx++)
      for (let ty = Math.floor((fy - R) / TILE); ty <= Math.floor((fy + R) / TILE); ty++) {
        const d = Math.hypot((tx + 0.5) * TILE - fx, (ty + 0.5) * TILE - fy);
        if (d < R + TILE * 0.7) want.push([`${tx},${ty}`, tx, ty, d]);
      }
    want.sort((a, b) => a[3] - b[3]);
    const now = performance.now();
    let built = 0;
    for (const [key, tx, ty] of want.slice(0, LOW ? 12 : 24)) {
      let t = this.tiles.get(key);
      if (!t) {
        if (built++ >= 2) continue; // spread generation over frames
        const g = new THREE.Group();
        const items = this.generate(rng(hash(key)), [tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE], Infinity);
        this.build(items, g, TILE);
        this.near.add(g);
        t = { group: g, used: now };
        this.tiles.set(key, t);
      }
      t.used = now;
      t.group.visible = true;
    }
    // Hide tiles we no longer want; evict the stalest beyond a cap.
    const wanted = new Set(want.slice(0, LOW ? 12 : 24).map((w) => w[0]));
    for (const [key, t] of this.tiles) if (!wanted.has(key)) t.group.visible = false;
    if (this.tiles.size > (LOW ? 24 : 48)) {
      const old = [...this.tiles.entries()].filter(([k]) => !wanted.has(k)).sort((a, b) => a[1].used - b[1].used);
      for (const [key, t] of old.slice(0, this.tiles.size - (LOW ? 24 : 48))) {
        this.near.remove(t.group);
        t.group.traverse((o) => {
          if ((o as THREE.InstancedMesh).isInstancedMesh) {
            (o as THREE.InstancedMesh).dispose();
            this.meshes.splice(this.meshes.indexOf(o as THREE.InstancedMesh), 1);
            const ri = this.roofMeshes.indexOf(o as THREE.InstancedMesh);
            if (ri >= 0) this.roofMeshes.splice(ri, 1);
          }
        });
        this.tiles.delete(key);
      }
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.geoBody.dispose();
    this.geoRoof.dispose();
    this.bodyMat.dispose();
    this.roofMat.dispose();
  }
}

type Item = { x: number; y: number; w: number; d: number; h: number; a: number; wall: THREE.Color; roof: THREE.Color; flat?: boolean };

/** Place toy buildings from the real building-coverage raster (see scripts/build-geo.ts). */
function parseRaster(buf: ArrayBuffer): Raster {
  const dv = new DataView(buf);
  const w = dv.getInt32(0, true);
  const h = dv.getInt32(4, true);
  return {
    w,
    h,
    minX: dv.getFloat32(8, true),
    maxY: dv.getFloat32(12, true),
    cell: dv.getFloat32(16, true),
    cov: new Uint8Array(buf, 20, w * h),
    hgt: new Uint8Array(buf, 20 + w * h, w * h),
    ang: buf.byteLength >= 20 + 3 * w * h ? new Uint8Array(buf, 20 + 2 * w * h, w * h) : null,
  };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Toy buildings from the real building-coverage raster (see scripts/build-geo.ts).
 * `box` limits generation to a map-space rectangle; `budget` thins uniformly (and enlarges) to fit.
 */
function fromDensity(
  r: Raster,
  grid: Grid,
  blocked: Uint8Array,
  core: Uint8Array,
  walls: THREE.Color[],
  roofs: THREE.Color[],
  rand: () => number,
  box: [number, number, number, number] | null,
  budget: number,
): Item[] {
  const { w, h, minX, maxY, cell, cov, hgt, ang } = r;
  const inCore = (x: number, y: number) => sampleMask(grid, core, x, y) === 1;
  const i0 = box ? Math.max(0, Math.floor((box[0] - minX) / cell)) : 0;
  const i1 = box ? Math.min(w - 1, Math.floor((box[2] - minX) / cell)) : w - 1;
  const j0 = box ? Math.max(0, Math.floor((maxY - box[3]) / cell)) : 0;
  const j1 = box ? Math.min(h - 1, Math.floor((maxY - box[1]) / cell)) : h - 1;
  // Expected building count per cell: coverage area / typical footprint for that height.
  const want = new Float32Array(w * h);
  let total = 0;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = j * w + i;
      const c = cov[k] / 255;
      if (c < 0.02) continue;
      const x = minX + (i + 0.5) * cell;
      const y = maxY - (j + 0.5) * cell;
      if (inCore(x, y) || sampleMask(grid, blocked, x, y)) continue;
      const bh = Math.max(4, hgt[k]);
      const foot = bh > 20 ? 700 : bh > 12 ? 320 : 110;
      const v = (c * cell * cell) / foot;
      want[k] = v;
      total += v;
    }
  const scale = Math.min(1, budget / Math.max(1, total));
  const out: Item[] = [];
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = j * w + i;
      const v = want[k] * scale;
      if (v <= 0) continue;
      let n = Math.floor(v) + (rand() < v % 1 ? 1 : 0);
      if (!n) continue;
      const c = cov[k] / 255;
      const bh = Math.max(4, hgt[k]);
      // When thinned by the budget, grow each building to keep the block's visual mass.
      const grow = Math.sqrt(1 / Math.max(scale, 0.2));
      const side = Math.sqrt((c * cell * cell) / Math.max(1, want[k])) * grow;
      const a = ang ? (ang[k] / 255) * (Math.PI / 2) : 0;
      while (n--) {
        const x = minX + (i + 0.15 + rand() * 0.7) * cell;
        const y = maxY - (j + 0.15 + rand() * 0.7) * cell;
        if (box && (x < box[0] || x >= box[2] || y < box[1] || y >= box[3])) continue;
        if (sampleMask(grid, blocked, x, y)) continue;
        const bw = THREE.MathUtils.clamp(side * (0.8 + rand() * 0.4), 6, cell * 0.9);
        const bd = THREE.MathUtils.clamp(side * (0.7 + rand() * 0.5), 6, cell * 0.9);
        out.push({
          x,
          y,
          w: bw,
          d: bd,
          h: bh * (0.8 + rand() * 0.4) * 0.6,
          a: a + (rand() < 0.5 ? 0 : Math.PI / 2),
          wall: walls[Math.floor(rand() * walls.length)],
          roof: roofs[Math.floor(rand() * roofs.length)],
          flat: bh >= 10,
        });
      }
    }
  return out;
}

function blur(src: Float32Array, W: number, H: number, r: number) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const n = 2 * r + 1;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[j * W + Math.min(W - 1, Math.max(0, i + k))];
      tmp[j * W + i] = s / n;
    }
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(H - 1, Math.max(0, j + k)) * W + i];
      out[j * W + i] = s / n;
    }
  return out;
}

function roofMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, lookUniforms);
    applyToon(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${LOOK_PARS}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uLk_suburbRoof * (0.8 + 0.4 * dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), uLk_suburbK);\ndiffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, uLk_bSat);');
  };
  m.customProgramCacheKey = () => 'suburb-roofs';
  return m;
}

function windowMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = groundUniforms.uNight;
    Object.assign(sh.uniforms, lookUniforms);
    applyToon(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLitSeed;\nvarying vec3 vLocal;')
      .replace('#include <common>', `#include <common>\n${LOOK_PARS}\n${VOXEL_SNAP_GLSL}`)
      .replace('#include <beginnormal_vertex>', 'mat4 bim = lkSnap(instanceMatrix);\n#define instanceMatrix bim\n#include <beginnormal_vertex>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;\nvLitSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uNight;\nvarying float vLitSeed;\nvarying vec3 vLocal;\n${LOOK_PARS}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uLk_suburbWall * (0.8 + 0.4 * dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), uLk_suburbK);\ndiffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, uLk_bSat);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float side = step(0.3, vLocal.y) * step(vLocal.y, 0.8) * step(0.001, abs(abs(vLocal.x) - 0.5) + abs(abs(vLocal.z) - 0.5) - 0.001);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.5, 0.56, 0.82), uNight * 0.65 * uLk_nightK);
        totalEmissiveRadiance += uLk_bLitCol * uLk_bLitK * uNight * side * step(1.0 - 0.55 * uLk_bLit, vLitSeed) * 0.55;`,
      );
  };
  m.customProgramCacheKey = () => 'suburb-walls';
  return m;
}

export type { Grid };
