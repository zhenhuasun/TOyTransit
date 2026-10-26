// SUPERSEDED — DO NOT WIRE INTO index.ts. The official feed moved from bustime.ttc.ca
// (unreachable from this environment) to gtfsrt.ttc.ca, which IS reachable and is wired in
// ttc-rt.ts. Measured 2026-10-26: vehicles/position is surface-only (~1,700 vehicles),
// trips/subway covers routes 1/2/4 with arrival predictions, and LRT 5/6 is in no feed.
// The old note below about trip_id/stop_id not joining was measured against the WRONG static
// feed (the merged GTFS): the RT feed joins against SurfaceGTFS.zip (open.toronto.ca
// surface-routes-and-schedules-for-bustime), where vehicle trip_ids match at 99.5%. The merged
// schedule's keys match RT trip_ids at ~0% — which is why ttc-rt.ts snaps surface positions by
// route_id only and strips subway trip keys before time matching, instead of using this file's
// kit-native gtfsRealtime path (whose VehiclePosition decoding also drops lat/lon, so it could
// never place vehicles precisely anyway).
// TTC's official GTFS-realtime as formerly known (TrackTTC / Clever Devices, bustime.ttc.ca):
//   TripUpdates + VehiclePositions: https://bustime.ttc.ca/gtfsrt/vehicles (protobuf)
// But it cannot be plugged into the kit's gtfsRealtime as-is, for two documented reasons:
//   1. The RT feed and the static GTFS share ONLY route_id. trip_id does not join, and stop_id joins
//      give plausible-looking WRONG matches (track-ttc Data Dictionary). With realtimeKeys stored,
//      the kit's 'both' matcher skips keyed trips that don't match AND skips them in time matching,
//      so bustime trips would be silently dropped.
//   2. The endpoint is unreachable from this VM (curl stalls after the TLS handshake, likely
//      bot/datacenter blocking), so no coverage — including whether subway is in the feed —
//      has been verified here.
// The working path turned out to be the one this comment sketched, implemented in ttc-rt.ts
// against gtfsrt.ttc.ca (not bustime.ttc.ca): reuse nextbus.ts's snapper (now snapper.ts,
// lat/lon -> pattern polyline -> synthesized timeline) on the official VehiclePositions, keyed
// by route_id only, plus the kit's decodeFeed for subway trip updates with keys stripped.
// This file's gtfsRealtime wiring is kept for reference only and must not be used: its
// VehiclePosition decoding drops lat/lon, and its trip keys (~0% join vs the merged schedule)
// would be silently dropped by the kit's 'both' matcher.
import { gtfsRealtime, type RealtimeSource } from '../gtfs/index.ts';

/** Historical wiring for reference only. SUPERSEDED by ttc-rt.ts (gtfsrt.ttc.ca). Do not use. */
export function createBustimeSource(): RealtimeSource {
  return gtfsRealtime({
    name: 'TTC GTFS-realtime',
    // Only the VehiclePositions URL is confirmed (track-ttc polls it every 30 s). The TripUpdates
    // URL is NOT stated here: it was never verified, and guessing it would be worse than omitting it.
    vehiclePositions: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    everyMs: 30_000,
  });
}
