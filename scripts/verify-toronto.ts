// Verification for Toronto's sim adapters (ferry/UP) across the day + live planes + live counts now.
// Run: npx tsx scripts/verify-toronto.ts
import { createAdapters } from '../server/adapters/toronto/index.ts';
import { fetchPlanes } from '../server/planes.ts';

const adapters = createAdapters({});
const sim = adapters.filter((a) => a.id === 'toronto-ferry' || a.id === 'toronto-up');
const toronto = (iso: string) => Date.parse(iso);
for (const iso of ['2026-10-24T06:45:00-04:00', '2026-10-24T08:20:00-04:00', '2026-10-24T12:00:00-04:00', '2026-10-24T17:30:00-04:00', '2026-10-24T23:40:00-04:00']) {
  const t = toronto(iso);
  for (const a of sim) {
    const trains = await a.poll(t);
    const sample = trains[0];
    console.log(`${iso} ${a.id}: ${trains.length} trains${sample ? ` e.g. ${sample.id} ${sample.line} -> ${sample.dest} stops=${sample.stops.map((s) => s.s).join('>')}` : ''}`);
  }
}
const now = Date.now();
const all = (await Promise.all(adapters.map(async (a) => ({ a, trains: await a.poll(now).catch(() => []) }))));
console.log('--- live poll now ---');
for (const { a, trains } of all) {
  console.log(`${a.id} (${a.name}): ${trains.length} trains, live=${trains.filter((t) => t.live).length}`);
}
const planes = await fetchPlanes('toronto').catch((e) => ({ error: String(e) }));
if ('error' in planes) console.log('planes: ERROR', planes.error);
else console.log(`planes: ${planes.planes.length} aircraft from ${planes.source}, e.g. ${planes.planes.slice(0, 3).map((p) => `${p.cs || p.hex}@${p.alt}ft`).join(', ')}`);
