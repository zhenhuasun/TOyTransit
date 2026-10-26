// One-time Halloween easter egg (Oct 2026): falling leaves, active only while
// Halloween mode is on. Temporary by design — delete with halloween.ts.
// Technique mirrors Precipitation (seed + time function of position, one draw
// call, no lights, no shadows), plus a tiny shader for per-leaf fade-in/out so
// leaves never pop at the ground. Cost: one THREE.Points draw call, <=120
// points, positions recomputed on the CPU per frame (trivial).
import * as THREE from 'three';
import { LOW } from './quality.ts';
import { isHalloweenOn } from './halloween.ts';
import type { FrameInfo, Layer } from './world.ts';

const MAX_LEAVES = 120;
const LOW_LEAVES = 48;
const PALETTE = ['#ff8c1a', '#ffc21a', '#e23b1e', '#a85b1e'];

function leafTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.translate(32, 32);
  g.rotate(Math.PI / 4);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(0, 0, 20, 12, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(-20, 0);
  g.lineTo(26, 0);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export class Leaves implements Layer {
  readonly group = new THREE.Group();
  private points: THREE.Points;
  private seeds: Float32Array;
  private pos: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private px: Float32Array;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.seeds = new Float32Array(MAX_LEAVES * 4);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = rnd();
    this.pos = new Float32Array(MAX_LEAVES * 3);
    this.col = new Float32Array(MAX_LEAVES * 3);
    this.alpha = new Float32Array(MAX_LEAVES);
    this.px = new Float32Array(MAX_LEAVES);
    const color = new THREE.Color();
    for (let i = 0; i < MAX_LEAVES; i++) {
      color.set(PALETTE[i % PALETTE.length]);
      this.col[i * 3] = color.r;
      this.col[i * 3 + 1] = color.g;
      this.col[i * 3 + 2] = color.b;
      this.px[i] = 10 + this.seeds[i * 4 + 3] * 8; // 10-18 CSS px
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aPx', new THREE.BufferAttribute(this.px, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: leafTexture() }, uDpr: { value: 1 } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aPx;
        uniform float uDpr;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aPx * uDpr;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float a = tex.a * vAlpha;
          if (a < 0.05) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.group.add(this.points);
    this.group.visible = false;
  }

  update(f: FrameInfo): void {
    const on = isHalloweenOn();
    this.group.visible = on;
    if (!on) return;
    const n = LOW ? LOW_LEAVES : MAX_LEAVES;
    const R = Math.min(f.radius * 1.2, 30000);
    const top = Math.min(Math.max(R * 0.5, 60), 400);
    const cx = f.focus.x;
    const cz = f.focus.z;
    const sway = Math.max(4, f.mpp * 6);
    const t = f.time;
    this.mat.uniforms.uDpr.value = Math.min(devicePixelRatio || 1, 2);
    for (let i = 0; i < n; i++) {
      const sx = this.seeds[i * 4];
      const sz = this.seeds[i * 4 + 1];
      const sy = this.seeds[i * 4 + 2];
      const ph = this.seeds[i * 4 + 3];
      // Fall cycle: 14-26 s per leaf. phase 0 = top of the sky, 1 = ground.
      const phase = (sy + t / (14 + ph * 12)) % 1;
      const x = cx + (sx - 0.5) * 2 * R + Math.sin(t * (0.8 + ph * 0.7) + ph * 40) * sway;
      const z = cz + (sz - 0.5) * 2 * R;
      const y = top * (1 - phase);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      // Fade in at spawn, fade out before touching the ground: no pops.
      const fadeIn = Math.min(1, phase / 0.08);
      const fadeOut = Math.min(1, (1 - phase) / 0.15);
      this.alpha[i] = Math.min(fadeIn, fadeOut);
    }
    this.points.geometry.setDrawRange(0, n);
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }
}
