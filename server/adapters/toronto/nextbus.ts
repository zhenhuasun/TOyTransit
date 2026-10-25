// NextBus live overlay for TTC buses and streetcars (keyless, ~15 s freshness).
// NextBus reports lat/lon/heading/speed per vehicle but no trip id and no next-stop ETAs, so this source
// snaps each vehicle onto its line's track (built from transit.json segments chained along the kit's
// stopping patterns) and synthesizes the timeline the kit's time matcher expects: the previous stop plus
// upcoming stops with ETAs from the vehicle's speed. Vehicles that match no timetable trip within the
// kit's tolerance still appear, via the kit's synthesize path, on the best-fitting pattern.
// NOTE: NextBus does not cover the subway (routeList has no tags 1/2/4), so subway trains stay
// timetable-only until the bustime GTFS-RT adapter (bustime.ts, unwired) is verified.
import { readJson } from '../../data.ts';
import { makeProjection } from '../../../shared/geo.ts';
import type { TransitData } from '../../../shared/types.ts';
import type { GtfsSchedule } from '../gtfs/schedule.ts';
import { politeFetch, type RealtimeSource, type RtTrip } from '../gtfs/realtime.ts';

const URL = 'https://webservices.nextbus.com/service/publicJSONFeed?command=vehicleLocations&a=ttc&t=0';
/** Fallback speeds (m/s) for ETA synthesis when a vehicle reports 0, by system. */
const FALLBACK_SPEED: Record<string, number> = { bus: 5.5, streetcar: 6.5, lrt: 7, subway: 9 };
const MAX_SNAP_M = 250;
const DWELL_S = 20;

interface NbVehicle {
  id: string;
  routeTag: string;
  lat: string;
  lon: string;
  heading?: string;
  speedKmHr?: string;
  secsSinceReport?: string;
}

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

export class NextBusSource implements RealtimeSource {
  name = 'NextBus';
  private tripsCache: RtTrip[] | undefined;
  private fetchedAt = 0;
  private paths: PatternPath[] | undefined;
  private lineByShort = new Map<string, { id: string; system: string }>();

  async refresh(nowMs: number, sched: GtfsSchedule): Promise<void> {
    if (nowMs - this.fetchedAt < 20_000 && this.tripsCache) return;
    this.buildPaths(sched);
    let res: Response;
    try {
      res = await politeFetch(URL, {}, { perMinute: 30 });
    } catch (err) {
      console.warn(`[nextbus] fetch failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!res.ok) {
      console.warn(`[nextbus] HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as { vehicle?: NbVehicle | NbVehicle[] };
    const vehicles = body.vehicle ? (Array.isArray(body.vehicle) ? body.vehicle : [body.vehicle]) : [];
    const now = nowMs / 1000;
    const out: RtTrip[] = [];
    for (const v of vehicles) {
      const t = this.toTrip(v, sched, now);
      if (t) out.push(t);
    }
    this.tripsCache = out;
    this.fetchedAt = nowMs;
  }

  trips(): RtTrip[] | undefined {
    if (!this.tripsCache || Date.now() - this.fetchedAt > 120_000) return undefined;
    return this.tripsCache;
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

  private toTrip(v: NbVehicle, sched: GtfsSchedule, now: number): RtTrip | undefined {
    const stale = Number(v.secsSinceReport ?? 0);
    if (stale > 120) return undefined;
    const line = this.lineByShort.get(v.routeTag) ?? this.lineByShort.get(v.routeTag.replace(/[A-Za-z]+$/, ''));
    if (!line) return undefined;
    const { project } = makeProjection('toronto');
    const [x, y] = project(Number(v.lon), Number(v.lat));
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
    const vMs = Number(v.speedKmHr ?? 0) > 1 ? Number(v.speedKmHr) / 3.6 : FALLBACK_SPEED[path.system] || 5.5;
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
