// Toronto: TTC subway, streetcars, LRT and buses, from the City of Toronto Open Data GTFS.
// Run: npx tsx scripts/build-toronto.ts [--refresh] [--debug]
// NOTE: the kit has no 'bus' LineKind (no kit city had buses before Toronto). Bus lines use kind 'tram'
// with osm: [] so shape misses fall back to straight lines instead of snapping to tram tracks; 'tram'
// also gives a realistic 16 m/s top speed in the client. Streetcar stock is the Flexity Outlook on all
// 501-512 routes and the overnight 301-312; LRT Lines 5/6 use Citadis Spirit cars.
import { buildGtfsCity } from './lib/gtfs/index.ts';

const STREETCARS: [string, string][] = [
  ['501', 'Queen'],
  ['503', 'Kingston Rd'],
  ['504', 'King'],
  ['505', 'Dundas'],
  ['506', 'Carlton'],
  ['507', 'Long Branch'],
  ['508', 'Lake Shore'],
  ['509', 'Harbourfront'],
  ['510', 'Spadina'],
  ['511', 'Bathurst'],
  ['512', 'St Clair'],
];
const NIGHT_CARS: [string, string][] = [
  ['301', 'Queen'],
  // 303 Kingston Rd has a route row but zero trips in the current feed, so it is not a line.
  ['304', 'King'],
  ['305', 'Dundas'],
  ['306', 'Carlton'],
  ['310', 'Spadina'],
  ['312', 'St Clair'],
];

await buildGtfsCity({
  city: 'toronto',
  feeds: [{ id: 'ttc', url: '.cache/toronto/OpenData_TTC_Schedules.zip' }],
  systems: [
    { id: 'subway', name: 'Subway', live: 'realtime' },
    { id: 'streetcar', name: 'Streetcar', live: 'realtime' },
    { id: 'lrt', name: 'LRT', live: 'realtime' },
    { id: 'bus', name: 'Bus', live: 'realtime' },
  ],
  lines: [
    { id: 'l1', system: 'subway', match: { routeType: 1, shortName: '1' }, name: 'Line 1 Yonge–University', short: '1', kind: 'metro', bullet: 'circle', stock: [{ stock: 'toronto-tr', cars: 6 }] },
    { id: 'l2', system: 'subway', match: { routeType: 1, shortName: '2' }, name: 'Line 2 Bloor–Danforth', short: '2', kind: 'metro', bullet: 'circle', stock: [{ stock: 'toronto-t1', cars: 6 }] },
    { id: 'l4', system: 'subway', match: { routeType: 1, shortName: '4' }, name: 'Line 4 Sheppard', short: '4', kind: 'metro', bullet: 'circle', stock: [{ stock: 'toronto-tr', cars: 6 }] },
    ...STREETCARS.map(([s, n]) => ({
      id: `s${s}`, system: 'streetcar', match: { routeType: 0, shortName: s }, name: `${s} ${n}`, short: s,
      kind: 'tram' as const, bullet: 'square' as const, stock: 'toronto-flexity',
    })),
    ...NIGHT_CARS.map(([s, n]) => ({
      id: `s${s}`, system: 'streetcar', match: { routeType: 0, shortName: s }, name: `${s} ${n} (Blue Night)`, short: s,
      kind: 'tram' as const, bullet: 'square' as const, stock: 'toronto-flexity',
    })),
    { id: 'l5', system: 'lrt', match: { routeType: 0, shortName: '5' }, name: 'Line 5 Eglinton', short: '5', kind: 'light', bullet: 'circle', stock: [{ stock: 'toronto-citadis', cars: 2 }] },
    { id: 'l6', system: 'lrt', match: { routeType: 0, shortName: '6' }, name: 'Line 6 Finch West', short: '6', kind: 'light', bullet: 'circle', stock: [{ stock: 'toronto-citadis', cars: 2 }] },
  ],
  routes: {
    match: { routeType: 3 },
    line: (r) => {
      const short = r.route_short_name?.trim();
      if (!short) return null;
      return {
        id: `b${short}`,
        system: 'bus',
        name: `${short} ${r.route_long_name ?? ''}`.trim(),
        short,
        kind: 'tram',
        bullet: 'square',
        stock: [
          { stock: 'toronto-nova', cars: 1, share: 3 },
          { stock: 'toronto-orion', cars: 1, share: 1 },
        ],
        osm: [],
      };
    },
  },
  stations: { idPrefix: 'tor', maxSpread: 120 },
  days: { from: -1, to: 6 },
  realtimeKeys: true,
  attribution: ['Timetables: City of Toronto Open Data (TTC)', 'Track levels © OpenStreetMap contributors'],
});
