// UP Express official realtime (Metrolinx OpenDataAPI, UPGTFSRealTimeV1), overlaying the
// timetable-simulated UP runs in timetable.ts. Same role as ttc-rt.ts for TTC, but UP has no
// kit GTFS schedule: positions are snapped to the UP corridor in transit.json directly, and
// matched to sim runs by direction + nearest scheduled trip.
//
// Endpoints (help page api.openmetrolinx.com/OpenDataAPI/Help/Index/en):
// - api/V1/UP/Gtfs/Feed/VehiclePosition: real vehicle positions (lat/lon, bearing, speed)
// - api/V1/UP/Gtfs/Feed/TripUpdates: per-stop arrival predictions
// Both return a GTFS-RT FeedMessage; JSON is requested via Accept (with a .json-suffix retry).
// The key query parameter follows the API's documented convention (`key=`); live verification
// of the exact parameter/format against the real feed is the deploy step's job, not this file's.
//
// KEY HANDLING — read this before touching this file:
// - The key comes ONLY from the environment (AdapterEnv.METROLINX_API_KEY: a Worker secret in
//   production, process.env locally). It is never hardcoded, never logged, never embedded in
//   error strings, and never sent to the browser: all fetching happens server-side in the hub.
// - Without a key this overlay is a silent no-op: no fetch, no error, sim trains serve as usual.
// - On ANY feed failure (non-200, bad JSON, empty, stale) the overlay yields nothing and the
//   timetable adapter serves sim trains instead — the client never sees an error or zero UP
//   trains. The hub keeps the last good live snapshot until it goes stale (STALE_MS).
// - Poll discipline is deliberate: one server-side fetch per 30 s shared by all visitors. The
//   API docs warn a key can be disabled on extensive calls, so this must never become a
//   per-client or per-train fetch.
//
// RT trip_ids are Metrolinx's own, NOT the sim's up-u-.../up-p-... ids, so they are never used
// as timetable keys. RT stop_ids are Metrolinx-internal codes absent from the map's data, so
// trip-update stops are mapped positionally from the vehicle's snapped anchor station (see
// applyUpdates), never by stop_id. Mount Dennis resolves through that anchor mapping: it is
// the 3rd station westbound / 3rd eastbound in the corridor order below.
import { readJson } from '../../data.ts';
import { makeProjection } from '../../../shared/geo.ts';
import type { TransitData, TrainState } from '../../../shared/types.ts';
import { politeFetch } from '../gtfs/realtime.ts';

/** Westbound corridor order: Union -> Pearson. Eastbound is the reverse. */
export const UP_WB = ['tor:up-union', 'tor:up-bloor', 'tor:up-mount-dennis', 'tor:up-weston', 'tor:up-pearson'];

const API = 'https://api.openmetrolinx.com/OpenDataAPI';
const EVERY_MS = 30_000;
const STALE_MS = 120_000;
const MAX_SNAP_M = 250;
const AT_STATION_M = 40;
const MATCH_M = 1500;
const DEFAULT_SPEED_MS = 14; // ~50 km/h, UP's average including stops (22 km / 28 min)
const DWELL_S = 60;

/** A sim run's legs, structurally (timetable.ts's Run, without importing it). */
export interface UpSimRun {
  id: string;
  dest: string;
  dir: string;
  stock: string;
  cars: number;
  legs: { s: string; arr: number; dep: number }[]; // day seconds, America/Toronto
}

/** One parsed vehicle position from the VehiclePosition feed. */
export interface UpVehicle {
  id: string;
  tripId: string;
  lat: number;
  lon: number;
  bearing?: number;
  speedMs?: number;
  /** Epoch seconds of the report, 0 when the feed omits it. */
  timestamp: number;
}

/** One parsed stop-time update from the TripUpdates feed. Times are epoch seconds. */
export interface UpStopUpdate {
  seq: number;
  arrivalTime?: number;
  arrivalDelay?: number;
  departureTime?: number;
  departureDelay?: number;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Parse a GTFS-RT VehiclePosition FeedMessage (JSON) into vehicle positions. */
export function parseUpVpFeed(json: unknown): UpVehicle[] {
  const out: UpVehicle[] = [];
  const entities = (json as { entity?: unknown[] } | null)?.entity;
  if (!Array.isArray(entities)) return out;
  for (const e of entities) {
    const v = (e as { vehicle?: Record<string, unknown> } | null)?.vehicle;
    if (!v || typeof v !== 'object') continue;
    const pos = v.position as Record<string, unknown> | undefined;
    const trip = v.trip as Record<string, unknown> | undefined;
    const veh = v.vehicle as Record<string, unknown> | undefined;
    const lat = num(pos?.latitude);
    const lon = num(pos?.longitude);
    if (lat === undefined || lon === undefined || lat === 0 || lon === 0) continue;
    const id = String(veh?.id ?? veh?.label ?? trip?.trip_id ?? '');
    if (!id) continue;
    out.push({
      id,
      tripId: String(trip?.trip_id ?? ''),
      lat,
      lon,
      bearing: num(pos?.bearing),
      speedMs: num(pos?.speed),
      timestamp: num(v.timestamp) ?? 0,
    });
  }
  return out;
}

/** Parse a GTFS-RT TripUpdates FeedMessage (JSON) into updates keyed by trip_id. */
export function parseUpTuFeed(json: unknown): Map<string, UpStopUpdate[]> {
  const out = new Map<string, UpStopUpdate[]>();
  const entities = (json as { entity?: unknown[] } | null)?.entity;
  if (!Array.isArray(entities)) return out;
  for (const e of entities) {
    const tu = (e as { trip_update?: Record<string, unknown> } | null)?.trip_update;
    if (!tu || typeof tu !== 'object') continue;
    const tripId = String((tu.trip as Record<string, unknown> | undefined)?.trip_id ?? '');
    if (!tripId) continue;
    const updates: UpStopUpdate[] = [];
    const stus = tu.stop_time_update;
    if (Array.isArray(stus)) {
      for (const s of stus) {
        const r = s as Record<string, unknown>;
        const arr = r.arrival as Record<string, unknown> | undefined;
        const dep = r.departure as Record<string, unknown> | undefined;
        updates.push({
          seq: num(r.stop_sequence) ?? 0,
          arrivalTime: num(arr?.time),
          arrivalDelay: num(arr?.delay),
          departureTime: num(dep?.time),
          departureDelay: num(dep?.delay),
        });
      }
    }
    updates.sort((a, b) => a.seq - b.seq);
    out.set(tripId, updates);
  }
  return out;
}

interface Corridor {
  /** Concatenated Union -> Pearson polyline (local meters), flat [x, y, ...]. */
  pts: number[];
  cum: number[]; // distance along pts at each vertex
  stationAt: number[]; // distance along pts at each UP_WB station, same order as UP_WB
  total: number;
}

function reverseFlat(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/** Seconds since local midnight in America/Toronto, DST-safe via Intl. */
function torontoDaySec(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

export class UpRtOverlay {
  private corridor: Corridor | undefined;
  private vehicles: UpVehicle[] | undefined;
  private updates = new Map<string, UpStopUpdate[]>();
  private fetchedAt = 0;
  private freshUntil = 0;
  private lastCount = 0;
  private inflight: Promise<void> | undefined;
  private prevAlong = new Map<string, number>();

  constructor(private readonly key?: string) {}

  /** True while the last successful fetch is fresh and yielded at least one vehicle. */
  get hasLive(): boolean {
    return this.lastCount > 0 && Date.now() < this.freshUntil;
  }

  /** Fetch both feeds (server-side, 30 s cache). No key => silent no-op. Never throws. */
  async refresh(nowMs: number): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.key) return;
    if (nowMs - this.fetchedAt < EVERY_MS && this.vehicles) return;
    this.inflight = this.load(nowMs).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(nowMs: number): Promise<void> {
    const [vpRes, tuRes] = await Promise.allSettled([this.fetchFeed('VehiclePosition'), this.fetchFeed('TripUpdates')]);
    if (vpRes.status === 'fulfilled') {
      this.vehicles = vpRes.value as UpVehicle[];
      this.updates = tuRes.status === 'fulfilled' ? (tuRes.value as Map<string, UpStopUpdate[]>) : new Map();
      this.fetchedAt = nowMs;
      this.freshUntil = Date.now() + STALE_MS;
      this.lastCount = this.vehicles.length;
    } else {
      // Keep the previous cache; the timetable serves sim trains until it goes stale.
      console.warn(`[up-rt] vehicle positions failed: ${vpRes.reason instanceof Error ? vpRes.reason.message : vpRes.reason}`);
      if (tuRes.status === 'rejected') console.warn('[up-rt] trip updates failed (positions kept as fallback)');
    }
  }

  /** Fetch one feed as JSON. Endpoint name only in errors — never the URL (it carries the key). */
  private async fetchFeed(feed: 'VehiclePosition' | 'TripUpdates'): Promise<UpVehicle[] | Map<string, UpStopUpdate[]>> {
    const base = `${API}/api/V1/UP/Gtfs/Feed/${feed}?key=${encodeURIComponent(this.key!)}`;
    for (const url of [base, base.replace(`/Feed/${feed}?`, `/Feed/${feed}.json?`)]) {
      try {
        const res = await politeFetch(url, { headers: { accept: 'application/json' } }, { perMinute: 4 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as unknown;
        const parsed = feed === 'VehiclePosition' ? parseUpVpFeed(json) : parseUpTuFeed(json);
        const empty = Array.isArray(parsed) ? parsed.length === 0 : parsed.size === 0;
        if (empty && url === base) continue; // maybe the format variant; try the .json URL
        return parsed;
      } catch (e) {
        if (url !== base) throw e;
        // First variant failed: fall through to the .json variant before giving up.
      }
    }
    throw new Error(`${feed} unreachable`);
  }

  private buildCorridor(): Corridor | undefined {
    if (this.corridor) return this.corridor;
    let transit: TransitData;
    try {
      transit = readJson<TransitData>('public/data/toronto/transit.json');
    } catch {
      return undefined;
    }
    const byId = new Map(transit.stations.map((s) => [s.id, s]));
    const segByPair = new Map<string, { from: string; to: string; lines: string[]; pts: number[] }>();
    for (const s of transit.segments) {
      const key = [s.from, s.to].sort().join('|');
      if (!segByPair.has(key)) segByPair.set(key, s);
    }
    const pts: number[] = [];
    const cum: number[] = [0];
    const stationAt: number[] = [0];
    for (let i = 0; i < UP_WB.length - 1; i++) {
      const seg = segByPair.get([UP_WB[i], UP_WB[i + 1]].sort().join('|'));
      if (!seg || !seg.lines.includes('up')) return undefined;
      const segPts = seg.from === UP_WB[i] ? seg.pts : reverseFlat(seg.pts);
      const start = pts.length ? 2 : 0; // skip the joint vertex (== previous segment's end)
      for (let j = start; j < segPts.length; j += 2) {
        if (pts.length) {
          const dx = segPts[j] - pts[pts.length - 2];
          const dy = segPts[j + 1] - pts[pts.length - 1];
          cum.push(cum[cum.length - 1] + Math.hypot(dx, dy));
        }
        pts.push(segPts[j], segPts[j + 1]);
      }
      stationAt.push(cum[cum.length - 1]);
    }
    if (pts.length < 4 || !byId.has(UP_WB[0])) return undefined;
    this.corridor = { pts, cum, stationAt, total: cum[cum.length - 1] };
    return this.corridor;
  }

  /** Nearest point on the corridor (Union -> Pearson frame). */
  private snap(x: number, y: number): { along: number; dist: number } | undefined {
    const c = this.buildCorridor();
    if (!c) return undefined;
    let best: { along: number; dist: number } | undefined;
    for (let j = 0; j < c.pts.length - 2; j += 2) {
      const ax = c.pts[j], ay = c.pts[j + 1], bx = c.pts[j + 2], by = c.pts[j + 3];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (!best || d < best.dist) best = { along: c.cum[j / 2] + t * Math.sqrt(len2), dist: d };
    }
    return best && best.dist <= MAX_SNAP_M ? best : undefined;
  }

  /** A sim run's scheduled along-distance (direction frame) at a day second, or undefined. */
  private runAlong(run: UpSimRun, daySec: number, wb: boolean): number | undefined {
    const c = this.corridor!;
    // Legs are already in travel order for both directions (up-u: Union first, up-p: Pearson
    // first); only the distance frame flips. dist(i) = distance from the direction origin.
    const legs = run.legs;
    const dist = (idx: number) => (wb ? c.stationAt[idx] : c.total - c.stationAt[UP_WB.length - 1 - idx]);
    for (let i = 0; i < legs.length; i++) {
      if (daySec >= legs[i].arr && daySec <= legs[i].dep) return dist(i);
      if (i + 1 < legs.length && daySec > legs[i].dep && daySec < legs[i + 1].arr) {
        const f = (daySec - legs[i].dep) / Math.max(1, legs[i + 1].arr - legs[i].dep);
        return dist(i) + f * (dist(i + 1) - dist(i));
      }
    }
    return undefined;
  }

  /**
   * Live trains for the current poll: matched sim runs (reusing the sim run id, live=true,
   * timeline shifted by the observed position offset and refined by trip updates) plus
   * synthesized trains for live vehicles with no matching sim run. Empty on any failure:
   * the caller then serves sim trains unchanged.
   */
  liveTrains(runs: UpSimRun[], nowMs: number): TrainState[] {
    if (!this.vehicles || Date.now() > this.freshUntil || !this.vehicles.length) return [];
    const c = this.buildCorridor();
    if (!c) return [];
    const nowSec = nowMs / 1000;
    const daySec = torontoDaySec(nowMs);
    const dayStart = nowSec - daySec;
    const { project } = makeProjection('toronto');
    const out: TrainState[] = [];
    for (const v of this.vehicles) {
      if (v.timestamp && nowSec - v.timestamp > 120) continue;
      const [x, y] = project(v.lon, v.lat);
      const s = this.snap(x, y);
      if (!s) continue;
      this.prevAlong.set(v.id, s.along);
      const wb = this.direction(v, s.along);
      if (wb === undefined) continue;
      const alongDir = wb ? s.along : c.total - s.along;
      const speed = v.speedMs !== undefined && v.speedMs > 1 && v.speedMs < 45 ? v.speedMs : DEFAULT_SPEED_MS;
      const matched = this.matchRun(runs, wb, daySec, alongDir);
      if (matched) {
        const t = this.matchedTrain(matched, wb, alongDir, speed, nowSec, dayStart, v);
        if (t) {
          out.push(t);
          continue;
        }
      }
      const t = this.synthTrain(v, wb, alongDir, speed, nowSec);
      if (t) out.push(t);
    }
    return out;
  }

  /** Westbound iff bearing heads northwest, movement heads Pearson-ward, or best sim match. */
  private direction(v: UpVehicle, alongWb: number): boolean | undefined {
    if (v.bearing !== undefined) {
      if (v.bearing >= 200 && v.bearing <= 340) return true; // northwest quadrant -> Pearson
      if (v.bearing >= 20 && v.bearing <= 160) return false; // southeast quadrant -> Union
    }
    const prev = this.prevAlong.get(v.id);
    if (prev !== undefined && Math.abs(alongWb - prev) > 20) return alongWb > prev;
    return undefined;
  }

  private matchRun(runs: UpSimRun[], wb: boolean, daySec: number, alongDir: number): UpSimRun | undefined {
    let best: { run: UpSimRun; d: number } | undefined;
    for (const r of runs) {
      const isWb = r.legs[0].s === UP_WB[0];
      if (isWb !== wb) continue;
      const a = this.runAlong(r, daySec, wb);
      if (a === undefined) continue;
      const d = Math.abs(a - alongDir);
      if (d < MATCH_M && (!best || d < best.d)) best = { run: r, d };
    }
    return best?.run;
  }

  private matchedTrain(run: UpSimRun, wb: boolean, alongDir: number, speed: number, nowSec: number, dayStart: number, v: UpVehicle): TrainState | undefined {
    const legs = run.legs; // already in travel order (see runAlong)
    const daySec = nowSec - dayStart;
    const simAlong = this.runAlong(run, daySec, wb);
    if (simAlong === undefined) return undefined;
    const delay = Math.max(-600, Math.min(600, (alongDir - simAlong) / speed));
    // Shifted epoch timeline, sliced like trainsNow (last departed leg onward, 60 s grace).
    const shifted = legs.map((l) => ({ s: l.s, a: dayStart + l.arr + delay, d: dayStart + l.dep + delay }));
    const last = shifted[shifted.length - 1];
    if (nowSec > last.a + 60) return undefined;
    let k = 0;
    for (let i = 0; i < shifted.length; i++) if (shifted[i].d <= nowSec) k = i;
    const stops = shifted.slice(k);
    if (stops.length < 2 && !(k === shifted.length - 1)) return undefined;
    const train: TrainState = {
      id: run.id, line: 'up', dest: run.dest, dir: run.dir,
      stock: run.stock, cars: run.cars, live: true, delay: Math.round(delay), stops,
    };
    this.applyUpdates(train, v.tripId, wb, alongDir, nowSec);
    return train;
  }

  /**
   * Refine a matched train's upcoming stops with trip-update predictions. Updates are mapped
   * positionally from the vehicle's snapped anchor station (first future update -> next station),
   * because RT stop_ids are Metrolinx-internal codes the map doesn't know. A vehicle dwelling
   * at a station anchors on that station; a moving one anchors on the next station ahead.
   */
  private applyUpdates(train: TrainState, tripId: string, wb: boolean, alongDir: number, nowSec: number): void {
    if (!tripId) return;
    const updates = this.updates.get(tripId);
    if (!updates?.length) return;
    const c = this.corridor!;
    const order = wb ? UP_WB : [...UP_WB].reverse();
    // Anchor: last station at/behind the vehicle in the direction frame.
    let posK = 0;
    for (let i = 0; i < order.length; i++) {
      const d = wb ? c.stationAt[i] : c.total - c.stationAt[UP_WB.length - 1 - i];
      if (d <= alongDir + AT_STATION_M) posK = i;
    }
    const atStation = Math.abs((wb ? c.stationAt[posK] : c.total - c.stationAt[UP_WB.length - 1 - posK]) - alongDir) <= AT_STATION_M;
    const firstIdx = atStation ? posK : posK + 1;
    const future = updates.filter((u) => (u.arrivalTime ?? u.departureTime ?? 0) > nowSec - 60);
    const byStation = new Map<string, UpStopUpdate>();
    future.forEach((u, j) => {
      if (firstIdx + j < order.length) byStation.set(order[firstIdx + j], u);
    });
    for (const st of train.stops) {
      const u = byStation.get(st.s);
      if (!u) continue;
      if (u.arrivalTime !== undefined) st.a = u.arrivalTime;
      else if (u.arrivalDelay !== undefined) st.a += u.arrivalDelay;
      if (u.departureTime !== undefined) st.d = u.departureTime;
      else if (u.departureDelay !== undefined) st.d += u.departureDelay;
      else if (u.arrivalTime !== undefined) st.d = Math.max(st.d, st.a + DWELL_S);
    }
  }

  /** A live vehicle with no matching sim run still appears, on the corridor pattern. */
  private synthTrain(v: UpVehicle, wb: boolean, alongDir: number, speed: number, nowSec: number): TrainState | undefined {
    const c = this.corridor!;
    const order = wb ? UP_WB : [...UP_WB].reverse();
    let posK = 0;
    for (let i = 0; i < order.length; i++) {
      const d = wb ? c.stationAt[i] : c.total - c.stationAt[UP_WB.length - 1 - i];
      if (d <= alongDir + AT_STATION_M) posK = i;
    }
    const dAt = wb ? c.stationAt[posK] : c.total - c.stationAt[UP_WB.length - 1 - posK];
    const atStation = Math.abs(dAt - alongDir) <= AT_STATION_M;
    const stops: TrainState['stops'] = [];
    if (atStation) {
      stops.push({ s: order[posK], a: nowSec - 30, d: nowSec + 30 });
    } else {
      const back = Math.max(0, (alongDir - dAt) / speed);
      stops.push({ s: order[posK], a: nowSec - back - DWELL_S, d: nowSec - back });
    }
    for (let j = posK + 1; j < order.length; j++) {
      const d = wb ? c.stationAt[j] : c.total - c.stationAt[UP_WB.length - 1 - j];
      const a = nowSec + Math.max(0, (d - alongDir) / speed);
      stops.push({ s: order[j], a, d: j === order.length - 1 ? a : a + DWELL_S });
    }
    if (stops.length < 2) return undefined;
    const safeId = v.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) || 'unknown';
    return {
      id: `up-live-${safeId}`, line: 'up',
      dest: wb ? 'Pearson Airport' : 'Union Station',
      dir: wb ? 'Westbound' : 'Eastbound',
      stock: 'toronto-up', cars: 2, live: true, stops,
    };
  }
}
