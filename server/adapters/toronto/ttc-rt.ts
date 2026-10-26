// Official TTC GTFS-RT source (gtfsrt.ttc.ca), primary realtime for Toronto.
//
// Verified live 2026-10-26 (binary protobuf, all endpoints HTTP 200 from this environment):
// - vehicles/position: SURFACE routes only (~1,700 vehicles; routes 1/2/4/5/6 = 0; release notes
//   3.0.0 Jan 2026: 'vehicle positions feed (surface routes only)'). Each vehicle carries trip_id,
//   route_id, lat/lon, bearing, speed, current stop and vehicle id.
// - trips/subway: live trip updates for subway routes 1/2/4 only (~100 trips; added release 3.4.1
//   Jun 2026). Per-stop arrival predictions, but NO vehicle lat/lon: subway positions stay
//   timetable-interpolated, adjusted by these predictions. NEVER synthesize fake 'live' positions.
// - trips/update (surface trip updates) is DEFERRED: its stop_ids map 99.1% to the merged
//   schedule, but feeding it alongside snapped positions would hand the kit two timelines for the
//   same bus (synthesized ETAs + predicted ETAs) with no defined merge. A future step can join
//   positions and trip updates by their SurfaceGTFS trip_id inside this source instead.
//
// Join measurements (binary feeds, 2026-10-26) that shape this file:
// - VehiclePositions trip_ids exist in SurfaceGTFS trips.txt at 99.5%, but in the merged
//   schedule's keys at 0.1%. So positions are snapped by route_id only (VehicleSnapper): the
//   feed's trip_ids are never used as timetable keys, and SurfaceGTFS is NOT needed at runtime.
// - Subway trip_update trip_ids exist in the merged schedule's keys at 0.0%, but their stop_ids
//   map to merged schedule stations at 100.0%. So subway keys are STRIPPED (keeping them would
//   make the kit's 'both' matcher drop the trips: a keyed trip with no timetable row is skipped
//   from time matching too) and the trips pair by line + stations + times instead.
// - LRT routes 5/6 appear in NO RT feed (0 in every feed). They stay timetable-simulated.
//
// Fallback: when the official vehicle positions fail (or snap to nothing), surface falls back to
// NextBusSource (same snapper, same rendering). Subway has no fallback and stays timetable.
// The source name reflects the fallback so the UI never claims official data it isn't showing.
//
// Worker-safe: global fetch only, no Node modules, no gtfs-realtime-bindings in this file (the
// kit's decodeFeed handles subway trip updates; vehicle positions use a small local reader
// because the kit's decodeVehicle does not capture lat/lon).
import { decodeFeed, politeFetch, type RealtimeSource, type RtTrip } from '../gtfs/realtime.ts';
import type { GtfsSchedule } from '../gtfs/schedule.ts';
import { NextBusSource } from './nextbus.ts';
import { VehicleSnapper, type SnapVehicle } from './snapper.ts';

const VP_URL = 'https://gtfsrt.ttc.ca/vehicles/position?format=binary';
const SUBWAY_TU_URL = 'https://gtfsrt.ttc.ca/trips/subway?format=binary';
/** Subway routes with a live trip-updates feed. LRT 5/6 are deliberately absent: no feed exists. */
const SUBWAY_ROUTES = new Set(['1', '2', '4']);
const EVERY_MS = 30_000;
const STALE_MS = 120_000;

const utf8 = new TextDecoder();

/** Minimal protobuf reader: only what VehiclePosition decoding needs (varint, string, float32). */
class PbReader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly end = buf.length,
  ) {}
  varint(): number {
    let x = 0, scale = 1, b: number;
    do {
      b = this.buf[this.pos++];
      x += (b & 0x7f) * scale;
      scale *= 128;
    } while (b & 0x80);
    return x;
  }
  fixed32(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  sub(): PbReader {
    const len = this.varint();
    const r = new PbReader(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return r;
  }
  string(): string {
    const len = this.varint();
    const s = utf8.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint();
      this.pos += len;
    } else if (wire === 5) this.pos += 4;
    else throw new Error(`protobuf wire type ${wire}`);
  }
  fields(f: (field: number, wire: number) => void) {
    while (this.pos < this.end) {
      const tag = this.varint();
      const at = this.pos;
      f(tag >>> 3, tag & 7);
      if (this.pos === at) this.skip(tag & 7);
    }
  }
}

interface RawVp {
  id: string;
  routeTag: string;
  lat: number;
  lon: number;
  speedMs: number;
  /** Epoch seconds of the position report, 0 when the feed omits it. */
  timestamp: number;
}

/**
 * Decode a VehiclePositions FeedMessage. Only trip, position (lat/lon/speed), vehicle id and
 * timestamp are read; everything else (current stop, status, occupancy) is skipped.
 */
function decodeVp(buf: Uint8Array): RawVp[] {
  const out: RawVp[] = [];
  const root = new PbReader(buf);
  while (root.pos < root.end) {
    const tag = root.varint();
    if (tag >>> 3 !== 2 || (tag & 7) !== 2) {
      root.skip(tag & 7);
      continue;
    }
    const ent = root.sub();
    ent.fields((ef, ew) => {
      if (ew !== 2 || ef !== 4) return; // FeedEntity.vehicle
      const vp = ent.sub();
      let tripId = '', routeId = '';
      let lat = 0, lon = 0, speed = 0, ts = 0;
      let vehId = '', vehLabel = '';
      vp.fields((f, w) => {
        if (f === 1 && w === 2) {
          const t = vp.sub();
          t.fields((tf, tw) => {
            if (tf === 1 && tw === 2) tripId = t.string();
            else if (tf === 5 && tw === 2) routeId = t.string();
          });
        } else if (f === 2 && w === 2) {
          const p = vp.sub();
          p.fields((pf, pw) => {
            if (pf === 1 && pw === 5) lat = p.fixed32();
            else if (pf === 2 && pw === 5) lon = p.fixed32();
            else if (pf === 4 && pw === 5) speed = p.fixed32();
          });
        } else if (f === 8 && w === 2) {
          const vd = vp.sub();
          vd.fields((vf, vw) => {
            if (vf === 1 && vw === 2) vehId = vd.string();
            else if (vf === 2 && vw === 2) vehLabel = vd.string();
          });
        } else if (f === 10 && w === 0) ts = vp.varint();
      });
      if (routeId && lat !== 0 && lon !== 0) {
        out.push({ id: vehLabel || vehId || tripId, routeTag: routeId, lat, lon, speedMs: speed, timestamp: ts });
      }
    });
  }
  return out;
}

export class TtcRtSource implements RealtimeSource {
  private tripsCache: RtTrip[] | undefined;
  private fetchedAt = 0;
  private fallback = false;
  private inflight: Promise<void> | undefined;
  private snapper = new VehicleSnapper();
  private nextbus = new NextBusSource();

  /** The adapter shows this name; it says so when the surface data is actually NextBus. */
  get name(): string {
    return this.fallback ? 'TTC GTFS-RT (NextBus fallback)' : 'TTC GTFS-RT';
  }

  async refresh(nowMs: number, sched: GtfsSchedule): Promise<void> {
    if (this.inflight) return this.inflight;
    if (nowMs - this.fetchedAt < EVERY_MS && this.tripsCache) return;
    this.inflight = this.load(nowMs, sched).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  trips(): RtTrip[] | undefined {
    if (!this.tripsCache || Date.now() - this.fetchedAt > STALE_MS) return undefined;
    return this.tripsCache;
  }

  private async load(nowMs: number, sched: GtfsSchedule): Promise<void> {
    const now = nowMs / 1000;
    const [vpRes, tuRes] = await Promise.allSettled([this.loadVp(), this.loadSubwayTu(sched)]);
    // Surface: official positions, snapped by route_id. Fall back to NextBus per mode, not
    // all-or-nothing: a subway feed outage must not cost surface positions, and vice versa.
    let surface: RtTrip[] = [];
    if (vpRes.status === 'fulfilled') surface = this.snapper.snap(this.toSnap(vpRes.value, now), sched, now);
    else console.warn(`[ttc-rt] vehicle positions failed: ${vpRes.reason instanceof Error ? vpRes.reason.message : vpRes.reason}`);
    let usedFallback = false;
    if (!surface.length) {
      if (vpRes.status === 'fulfilled') console.warn('[ttc-rt] vehicle positions snapped to nothing, falling back to NextBus for surface');
      await this.nextbus.refresh(nowMs, sched);
      surface = this.nextbus.trips(nowMs) ?? [];
      usedFallback = surface.length > 0;
      if (!surface.length) console.warn('[ttc-rt] NextBus fallback also empty; surface stays timetable');
    }
    const trips = [...surface];
    if (tuRes.status === 'fulfilled') trips.push(...tuRes.value);
    else console.warn(`[ttc-rt] subway trip updates failed: ${tuRes.reason instanceof Error ? tuRes.reason.message : tuRes.reason} (subway stays timetable)`);
    if (!trips.length) return; // keep the previous cache; the adapter shows timetable
    this.tripsCache = trips;
    this.fetchedAt = nowMs;
    this.fallback = usedFallback;
  }

  private async loadVp(): Promise<RawVp[]> {
    const res = await politeFetch(VP_URL, { headers: { accept: 'application/x-protobuf' } }, { perMinute: 20 });
    return decodeVp(new Uint8Array(await res.arrayBuffer()));
  }

  private async loadSubwayTu(sched: GtfsSchedule): Promise<RtTrip[]> {
    const res = await politeFetch(SUBWAY_TU_URL, { headers: { accept: 'application/x-protobuf' } }, { perMinute: 20 });
    const tus = decodeFeed(new Uint8Array(await res.arrayBuffer()), {
      keep: (d) => SUBWAY_ROUTES.has(d.routeId),
      station: (stopId) => sched.station(stopId),
      line: (routeId) => {
        const li = sched.data.routes[routeId];
        return li == null ? undefined : sched.data.lines[li].id;
      },
    });
    // Measured 0% of subway trip_ids join the merged schedule's keys, while 100% of their
    // stop_ids map to merged stations. Keys are stripped so the kit's time matcher pairs these
    // trips by line + stations + times; kept keys would be dropped outright (see adapter.ts:
    // under 'both' matching, a keyed trip with no timetable row is skipped from time matching).
    const out: RtTrip[] = [];
    for (const t of tus) {
      if (!t.line || (!t.stops?.length && t.delay == null)) continue;
      t.key = undefined;
      out.push(t);
    }
    return out;
  }

  private toSnap(raw: RawVp[], now: number): SnapVehicle[] {
    return raw.map((v) => ({
      id: v.id,
      routeTag: v.routeTag,
      lat: v.lat,
      lon: v.lon,
      speedMs: v.speedMs,
      secsSinceReport: v.timestamp ? Math.max(0, now - v.timestamp) : 0,
    }));
  }
}
