// Vehicle snapper: turns live vehicle positions (lat/lon + speed) into the kit's RtTrip model by
// snapping each vehicle onto its line's track (built from transit.json segments chained along the
// kit's stopping patterns) and synthesizing the timeline the kit's time matcher expects: the previous
// stop plus upcoming stops with ETAs from the vehicle's speed. Vehicles that match no timetable trip
// within the kit's tolerance still appear, via the kit's synthesize path, on the best-fitting pattern.
//
// Extracted from nextbus.ts (which now delegates here) so the official TTC GTFS-RT positions
// (ttc-rt.ts) reuse the exact same snapper with a different vehicle provider. The snapper is keyed
// by route_id only: it never needs the feed's trip_ids to join the timetable, which is what makes
// it work for feeds whose trip_ids belong to a different static feed than the schedule.
import { readJson } from '../../data.ts';
import { makeProjection } from '../../../shared/geo.ts';
import type { TransitData } from '../../../shared/types.ts';
import type { GtfsSchedule } from '../gtfs/schedule.ts';
import type { RtTrip } from '../gtfs/realtime.ts';

/** A live vehicle position, in the snapper's units (meters per second, decimal degrees). */
export interface SnapVehicle {
  id: string;
  /** GTFS route_id (NextBus routeTag uses the same namespace). */
  routeTag: string;
  lat: number;
  lon: number;
  /** m/s; when absent or <= 1/3.6, a per-system fallback speed is used. */
  speedMs?: number;
  /** Seconds since the position was reported; vehicles older than 120 s are dropped. */
  secsSinceReport?: number;
}

/** Fallback speeds (m/s) for ETA synthesis when a vehicle reports 0, by system. */
const FALLBACK_SPEED: Record<string, number> = { bus: 5.5, streetcar: 6.5, lrt: 7, subway: 9 };
const MAX_SNAP_M = 250;
const DWELL_S = 20;

interface PatternPath {
  line: string;
  system: string;
  stations: string[]; // station ids in order
  pts: number[]; // flat polyline
  cum: number[]; // distance along pts at each vertex
  stationAt: number[]; // distance along pts at each station
  minX: number; minY: number; maxX: number; maxY: number;
}

function reverseFlat(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

export class VehicleSnapper {
  private paths: PatternPath[] | undefined;
  private lineByShort = new Map<string, { id: string; system: string }>();

  snap(vehicles: SnapVehicle[], sched: GtfsSchedule, now: number): RtTrip[] {
    this.buildPaths(sched);
    const out: RtTrip[] = [];
    for (const v of vehicles) {
      const t = this.toTrip(v, sched, now);
      if (t) out.push(t);
    }
    return out;
  }

  private buildPaths(sched: GtfsSchedule): void {
    if (this.paths) return;
    const transit = readJson<TransitData>('public/data/toronto/transit.json');
    const sysRank: Record<string, number> = { subway: 0, streetcar: 1, lrt: 2, bus: 3 };
    for (const l of transit.lines) {
      const prev = this.lineByShort.get(l.short);
      if (!prev || (sysRank[l.system] ?? 9) < (sysRank[prev.system] ?? 9)) this.lineByShort.set(l.short, { id: l.id, system: l.system });
    }
    const segByPair = new Map<string, { from: string; to: string; lines: string[]; pts: number[] }[]>();
    for (const s of transit.segments) {
      const key = [s.from, s.to].sort().join('|');
      (segByPair.get(key) ?? segByPair.set(key, []).get(key)!).push(s);
    }
    const paths: PatternPath[] = [];
    for (const l of transit.lines) {
      const li = sched.lineIndex.get(l.id);
      if (li == null) continue;
      for (const p of sched.patterns(li)) {
        const stIds = sched.patStations[p.pat];
        if (stIds.length < 2) continue;
        const pts: number[] = [];
        const cum: number[] = [0];
        const stationAt: number[] = [0];
        let ok = true;
        for (let i = 0; i < stIds.length - 1; i++) {
          const cands = segByPair.get([stIds[i], stIds[i + 1]].sort().join('|')) ?? [];
          const seg = cands.find((s) => s.lines.includes(l.id)) ?? cands[0];
          if (!seg) { ok = false; break; }
          const segPts = seg.from === stIds[i] ? seg.pts : reverseFlat(seg.pts);
          const start = pts.length ? 2 : 0; // skip the joint vertex (== previous segment's end)
          for (let j = start; j < segPts.length; j += 2) {
            const px = segPts[j], py = segPts[j + 1];
            if (pts.length) {
              const dx = px - pts[pts.length - 2], dy = py - pts[pts.length - 1];
              cum.push(cum[cum.length - 1] + Math.hypot(dx, dy));
            }
            pts.push(px, py);
          }
          stationAt.push(cum[cum.length - 1]);
        }
        if (!ok || pts.length < 4) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j < pts.length; j += 2) {
          minX = Math.min(minX, pts[j]); maxX = Math.max(maxX, pts[j]);
          minY = Math.min(minY, pts[j + 1]); maxY = Math.max(maxY, pts[j + 1]);
        }
        paths.push({ line: l.id, system: l.system, stations: stIds, pts, cum, stationAt, minX, minY, maxX, maxY });
      }
    }
    this.paths = paths;
  }

  private toTrip(v: SnapVehicle, sched: GtfsSchedule, now: number): RtTrip | undefined {
    const stale = v.secsSinceReport ?? 0;
    if (stale > 120) return undefined;
    const line = this.lineByShort.get(v.routeTag) ?? this.lineByShort.get(v.routeTag.replace(/[A-Za-z]+$/, ''));
    if (!line) return undefined;
    const { project } = makeProjection('toronto');
    const [x, y] = project(v.lon, v.lat);
    let best: { path: PatternPath; dist: number; along: number } | undefined;
    for (const path of this.paths ?? []) {
      if (path.line !== line.id) continue;
      if (x < path.minX - MAX_SNAP_M || x > path.maxX + MAX_SNAP_M || y < path.minY - MAX_SNAP_M || y > path.maxY + MAX_SNAP_M) continue;
      for (let j = 0; j < path.pts.length - 2; j += 2) {
        const ax = path.pts[j], ay = path.pts[j + 1], bx = path.pts[j + 2], by = path.pts[j + 3];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (!best || d < best.dist) best = { path, dist: d, along: path.cum[j / 2] + t * Math.sqrt(len2) };
      }
    }
    if (!best || best.dist > MAX_SNAP_M) return undefined;
    const { path, along } = best;
    // Use the reported speed when it is meaningfully nonzero; the 1/3.6 m/s threshold preserves
    // the original NextBus rule (>1 km/h) in m/s units. A stopped vehicle falls back to system speed
    // so ETAs stay finite.
    const vMs = (v.speedMs ?? 0) > 1 / 3.6 ? v.speedMs! : FALLBACK_SPEED[path.system] || 5.5;
    // Station the vehicle is at (within 40 m) or has most recently passed.
    let k = 0;
    for (let i = 0; i < path.stationAt.length; i++) if (path.stationAt[i] <= along + 40) k = i;
    const atStation = Math.abs(path.stationAt[k] - along) <= 40;
    const stops: NonNullable<RtTrip['stops']> = [];
    const startIdx = atStation ? k : k;
    for (let j = startIdx; j < Math.min(path.stations.length, startIdx + 13); j++) {
      const idx = sched.stationIndex(path.stations[j]);
      if (idx == null) continue;
      if (j === startIdx && !atStation) {
        // Previous stop: estimated departure time, in the past.
        const d = now - Math.max(0, (along - path.stationAt[j]) / vMs);
        stops.push({ station: idx, a: d - DWELL_S, d });
      } else if (j === startIdx && atStation) {
        stops.push({ station: idx, a: now - 30, d: now + 30 });
      } else {
        const a = now + Math.max(0, (path.stationAt[j] - along) / vMs);
        stops.push({ station: idx, a, d: a + DWELL_S });
      }
    }
    if (!stops.length) return undefined;
    const nextIdx = stops[atStation ? 0 : 1]?.station ?? stops[0].station;
    return { line: line.id, label: v.id, at: { station: nextIdx, status: atStation ? 'at' : 'to' }, stops };
  }
}
