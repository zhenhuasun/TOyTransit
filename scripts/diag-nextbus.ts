// Diagnostic: compare live NextBus vehicles against the trips the snapper produces, by route.
// Run: npx tsx scripts/diag-nextbus.ts (from ~/workspace/toronto-toy-map)
import { GtfsSchedule } from '../server/adapters/gtfs/schedule.ts';
import { NextBusSource } from '../server/adapters/toronto/nextbus.ts';

const sched = GtfsSchedule.load('server/data/toronto/schedule.json');
const src = new NextBusSource();
await src.refresh(Date.now(), sched);
const trips = src.trips() ?? [];
const raw = await (await fetch('https://webservices.nextbus.com/service/publicJSONFeed?command=vehicleLocations&a=ttc&t=0')).json() as { vehicle?: any | any[] };
const vehicles = raw.vehicle ? (Array.isArray(raw.vehicle) ? raw.vehicle : [raw.vehicle]) : [];
const byRoute = new Map<string, number>();
for (const v of vehicles) byRoute.set(v.routeTag, (byRoute.get(v.routeTag) ?? 0) + 1);
const byLine = new Map<string, number>();
for (const t of trips) byLine.set(t.line ?? '?', (byLine.get(t.line ?? '?') ?? 0) + 1);
console.log(`vehicles: ${vehicles.length}, trips: ${trips.length}`);
const lineByShort = (src as any).lineByShort as Map<string, { id: string }>;
for (const [tag, n] of [...byRoute.entries()].sort()) {
  const line = lineByShort.get(tag)?.id ?? lineByShort.get(tag.replace(/[A-Za-z]+$/, ''))?.id;
  const got = line ? byLine.get(line) ?? 0 : 0;
  if (got !== n) console.log(`  route ${tag}: vehicles=${n} trips_on_line=${got} line=${line ?? 'NO MAPPING'}`);
}
console.log('routes fully covered or over-covered not listed above');
