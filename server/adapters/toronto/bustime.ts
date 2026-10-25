// UNVERIFIED — DO NOT WIRE INTO index.ts UNTIL VERIFIED FROM A NON-BLOCKED NETWORK.
// TTC's official GTFS-realtime (TrackTTC / Clever Devices, bustime.ttc.ca) exists:
//   TripUpdates + VehiclePositions: https://bustime.ttc.ca/gtfsrt/vehicles (protobuf)
// But it cannot be plugged into the kit's gtfsRealtime as-is, for two documented reasons:
//   1. The RT feed and the static GTFS share ONLY route_id. trip_id does not join, and stop_id joins
//      give plausible-looking WRONG matches (track-ttc Data Dictionary). With realtimeKeys stored,
//      the kit's 'both' matcher skips keyed trips that don't match AND skips them in time matching,
//      so bustime trips would be silently dropped.
//   2. The endpoint is unreachable from this VM (curl stalls after the TLS handshake, likely
//      bot/datacenter blocking), so no coverage — including whether subway is in the feed —
//      has been verified here.
// The working path, when bustime is reachable, is NOT gtfsRealtime: reuse nextbus.ts's snapper
// (lat/lon -> pattern polyline -> synthesized timeline) on bustime's VehiclePositions, keyed by
// route_id only. That is a small refactor of NextBusSource to take a vehicle provider; it is
// deliberately not done here so v1 ships on the verified NextBus path.
import { gtfsRealtime, type RealtimeSource } from '../gtfs/index.ts';

/** Wiring for reference only. See the header comment: do not use until verified. */
export function createBustimeSource(): RealtimeSource {
  return gtfsRealtime({
    name: 'TTC GTFS-realtime',
    // Only the VehiclePositions URL is confirmed (track-ttc polls it every 30 s). The TripUpdates
    // URL is NOT stated here: it was never verified, and guessing it would be worse than omitting it.
    vehiclePositions: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    everyMs: 30_000,
  });
}
