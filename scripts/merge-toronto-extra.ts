// Appends the non-GTFS systems (Island Ferry, Billy Bishop ferry, UP Express) to Toronto's transit.json.
// The TTC part is built by scripts/build-toronto.ts; this script adds stations, segments and lines for the
// three hand-timetabled systems, whose adapters live in server/adapters/toronto/.
// Run after every rebuild: npx tsx scripts/merge-toronto-extra.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { makeProjection } from '../shared/geo.ts';
import type { LineDef, SystemDef, TransitData } from '../shared/types.ts';

const { project } = makeProjection('toronto');
const P = (lon: number, lat: number) => project(lon, lat);

// Island Ferry terminals (exact, from the task brief) and UP Express stations (exact, from the GO slim GTFS
// in the user's mini-gotransit-3d workspace: Union/Bloor/Weston GO stations, Pearson Terminal 1 GO bus stop).
// Billy Bishop ferry terminals are geocoded exact (2026-10-25, FULL_ADDRESS matches): Eireann Quay on the
// mainland (foot of Bathurst St) and the island-side slip on the north shore — both on the water's edge, so
// the crossing is water-only. The previous coords put both docks ~600-800 m south, on island land.
const STOPS: Record<string, { name: string; lon: number; lat: number; lines: string[] }> = {
  'tor:ferry-city': { name: 'Jack Layton Ferry Terminal', lon: -79.37517, lat: 43.6402, lines: ['f-ward', 'f-centre', 'f-hanlans'] },
  'tor:ferry-centre': { name: 'Centre Island', lon: -79.37844, lat: 43.62245, lines: ['f-centre'] },
  'tor:ferry-hanlans': { name: "Hanlan's Point", lon: -79.38905, lat: 43.62791, lines: ['f-hanlans'] },
  'tor:ferry-wards': { name: "Ward's Island", lon: -79.35771, lat: 43.63139, lines: ['f-ward'] },
  'tor:bb-city': { name: 'Eireann Quay', lon: -79.39771, lat: 43.63393, lines: ['f-bb'] },
  'tor:bb-airport': { name: 'Billy Bishop Airport', lon: -79.39657, lat: 43.63253, lines: ['f-bb'] },
  'tor:up-union': { name: 'Union Station', lon: -79.3806, lat: 43.645195, lines: ['up'] },
  'tor:up-bloor': { name: 'Bloor', lon: -79.450192, lat: 43.656928, lines: ['up'] },
  'tor:up-weston': { name: 'Weston', lon: -79.51368, lat: 43.70029, lines: ['up'] },
  'tor:up-pearson': { name: 'Pearson Airport', lon: -79.6132584, lat: 43.6821671, lines: ['up'] },
};

const path = 'public/data/toronto/transit.json';
const data = JSON.parse(readFileSync(path, 'utf8')) as TransitData;
const have = new Set(data.stations.map((s) => s.id));
for (const [id, s] of Object.entries(STOPS)) {
  if (have.has(id)) continue;
  const [x, y] = P(s.lon, s.lat);
  data.stations.push({ id, name: s.name, x, y, lines: s.lines });
}
const seg = (a: string, b: string, lines: string[], via: [number, number][] = []) => {
  const sa = data.stations.find((s) => s.id === a)!;
  const sb = data.stations.find((s) => s.id === b)!;
  if (data.segments.some((s) => (s.from === a && s.to === b) || (s.from === b && s.to === a))) return;
  const pts: number[] = [sa.x, sa.y];
  for (const [lon, lat] of via) {
    const [x, y] = P(lon, lat);
    pts.push(x, y);
  }
  pts.push(sb.x, sb.y);
  data.segments.push({ from: a, to: b, lines, pts, el: new Array(pts.length / 2).fill(0) });
};
seg('tor:ferry-city', 'tor:ferry-wards', ['f-ward']);
seg('tor:ferry-city', 'tor:ferry-centre', ['f-centre']);
seg('tor:ferry-city', 'tor:ferry-hanlans', ['f-hanlans']);
seg('tor:bb-city', 'tor:bb-airport', ['f-bb']);
seg('tor:up-union', 'tor:up-bloor', ['up']);
seg('tor:up-bloor', 'tor:up-weston', ['up']);
// UP Express follows the Kitchener corridor northwest from Weston and turns south ONLY at Hwy 427
// north of Pearson — never a diagonal cut. Corridor points are verbatim GO Kitchener shape points
// (slim GTFS shape UNMO); the junction is the shape point nearest Hwy 427's longitude.
seg('tor:up-weston', 'tor:up-pearson', ['up'], [
  [-79.53096, 43.70681], // corridor bend (UNMO seq 107)
  [-79.56185, 43.70636], // Etobicoke North area (UNMO seq 121)
  [-79.59838, 43.70562], // Hwy 427 junction (UNMO seq 131): turn south here
  [-79.606, 43.694], // mid-spur into Terminal 1
]);

const LINES: LineDef[] = [
  { id: 'f-ward', system: 'ferry', name: "Ward's Island Ferry", short: 'W', color: '#1F6FB2', textColor: '#FFFFFF', kind: 'tram', bullet: 'pill', stock: 'toronto-ferry' },
  { id: 'f-centre', system: 'ferry', name: 'Centre Island Ferry', short: 'C', color: '#1F6FB2', textColor: '#FFFFFF', kind: 'tram', bullet: 'pill', stock: 'toronto-ferry' },
  { id: 'f-hanlans', system: 'ferry', name: "Hanlan's Point Ferry", short: 'H', color: '#1F6FB2', textColor: '#FFFFFF', kind: 'tram', bullet: 'pill', stock: 'toronto-ferry' },
  { id: 'f-bb', system: 'ferry', name: 'Billy Bishop Ferry', short: 'YTZ', color: '#1F6FB2', textColor: '#FFFFFF', kind: 'tram', bullet: 'pill', stock: 'toronto-bbferry' },
  { id: 'up', system: 'up', name: 'UP Express', short: 'UP', color: '#1F6FB2', textColor: '#FFFFFF', kind: 'rail', bullet: 'pill', stock: 'toronto-up' },
];
for (const l of LINES) if (!data.lines.some((x) => x.id === l.id)) data.lines.push(l);
for (const s of [
  { id: 'ferry', name: 'Ferry', live: 'scheduled' },
  { id: 'up', name: 'UP Express', live: 'scheduled' },
] as SystemDef[]) if (!data.systems.some((x) => x.id === s.id)) data.systems.push(s);

writeFileSync(path, JSON.stringify(data));
console.log(`merged: ${data.stations.length} stations, ${data.segments.length} segments, ${data.lines.length} lines`);
