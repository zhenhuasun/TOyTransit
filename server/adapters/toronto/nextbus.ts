// NextBus live overlay for TTC buses and streetcars (keyless, ~15 s freshness).
// NextBus reports lat/lon/heading/speed per vehicle but no trip id and no next-stop ETAs, so this
// source snaps each vehicle onto its line's track via the shared VehicleSnapper (snapper.ts) and
// synthesizes the timeline the kit's time matcher expects.
//
// NOTE: NextBus is no longer the primary source. The official TTC GTFS-RT feed (ttc-rt.ts) is
// primary; this source stays as its FALLBACK when the official fetch fails. NextBus does not cover
// the subway or LRT (routeList has no tags 1/2/4/5/6): subway now gets live arrival predictions
// from the official trips/subway feed, and LRT stays timetable-simulated.
import { politeFetch, type RealtimeSource, type RtTrip } from '../gtfs/realtime.ts';
import type { GtfsSchedule } from '../gtfs/schedule.ts';
import { VehicleSnapper, type SnapVehicle } from './snapper.ts';

const URL = 'https://webservices.nextbus.com/service/publicJSONFeed?command=vehicleLocations&a=ttc&t=0';

interface NbVehicle {
  id: string;
  routeTag: string;
  lat: string;
  lon: string;
  heading?: string;
  speedKmHr?: string;
  secsSinceReport?: string;
}

export class NextBusSource implements RealtimeSource {
  name = 'NextBus';
  private tripsCache: RtTrip[] | undefined;
  private fetchedAt = 0;
  private snapper = new VehicleSnapper();

  async refresh(nowMs: number, sched: GtfsSchedule): Promise<void> {
    if (nowMs - this.fetchedAt < 20_000 && this.tripsCache) return;
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
    const snap: SnapVehicle[] = vehicles.map((v) => ({
      id: v.id,
      routeTag: v.routeTag,
      lat: Number(v.lat),
      lon: Number(v.lon),
      speedMs: Number(v.speedKmHr ?? 0) / 3.6,
      secsSinceReport: Number(v.secsSinceReport ?? 0),
    }));
    this.tripsCache = this.snapper.snap(snap, sched, now);
    this.fetchedAt = nowMs;
  }

  trips(_nowMs?: number): RtTrip[] | undefined {
    if (!this.tripsCache || Date.now() - this.fetchedAt > 120_000) return undefined;
    return this.tripsCache;
  }
}
