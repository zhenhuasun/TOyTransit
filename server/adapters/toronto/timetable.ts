// Timetable-simulated adapters for Toronto's non-GTFS systems: the Island Ferry (winter schedule,
// verified from the City of Toronto ferry page on 2026-10-25), the Billy Bishop ferry, and UP Express.
// Trains appear when they leave their origin and vanish at their terminus, per the DATA_BRIEF contract.
// Centre Island and Hanlan's Point ferries run mid-April to mid-October only, so they have no winter
// service and are intentionally absent here; their summer timetables need fetching when the City posts them.
import type { TrainState } from '../../../shared/types.ts';
import type { Adapter, AdapterFactory } from '../types.ts';
import { UpRtOverlay } from './up-rt.ts';

/** Seconds since local midnight in America/Toronto, DST-safe via Intl. */
function torontoDaySec(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

interface Leg {
  s: string; // station id
  arr: number; // seconds since midnight
  dep: number;
}
interface Run {
  id: string;
  line: string;
  stock: string;
  cars: number;
  dest: string;
  dir: string;
  legs: Leg[];
}

function trainsNow(runs: Run[], nowMs: number): TrainState[] {
  const daySec = torontoDaySec(nowMs);
  const now = nowMs / 1000;
  // Local-midnight epoch seconds, for converting day seconds to epoch times.
  const dayStart = now - daySec;
  const out: TrainState[] = [];
  for (const r of runs) {
    const first = r.legs[0], last = r.legs[r.legs.length - 1];
    if (daySec < first.dep || daySec > last.arr + 60) continue;
    let k = 0;
    for (let i = 0; i < r.legs.length; i++) if (r.legs[i].dep <= daySec) k = i;
    const stops = r.legs.slice(k).map((l) => ({ s: l.s, a: dayStart + l.arr, d: dayStart + l.dep }));
    // A single stop is allowed when dwelling at a terminal (DATA_BRIEF); that only happens in the
    // 60 s grace window after arrival, after which the run drops out.
    out.push({ id: r.id, line: r.line, dest: r.dest, dir: r.dir, stock: r.stock, cars: r.cars, live: false, stops });
  }
  return out;
}

function simAdapter(id: string, name: string, runs: Run[]): Adapter {
  return { id, city: 'toronto', name, live: false, intervalMs: 30_000, poll: async (now) => trainsNow(runs, now) };
}

// --- Ward's Island ferry, winter schedule (City of Toronto, Oct 14 to mid-April) ---
// Crossing: 15 min. City departures and Ward's departures (+15 min) as published.
const WARD_CITY = [6 * 60 + 30, 7 * 60, 7 * 60 + 30, 8 * 60 + 15, 9 * 60, 9 * 60 + 30, 10 * 60 + 30, 11 * 60 + 30, 12 * 60, 12 * 60 + 30, 13 * 60 + 30, 14 * 60, 14 * 60 + 30, 15 * 60 + 30, 16 * 60, 16 * 60 + 30, 17 * 60 + 30, 18 * 60, 18 * 60 + 30, 19 * 60 + 30, 20 * 60 + 30, 21 * 60 + 30, 22 * 60 + 30, 23 * 60, 23 * 60 + 30];
const ferryRuns: Run[] = [];
for (const t of WARD_CITY) {
  const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
  ferryRuns.push({
    id: `ferry-ward-${hh}${mm}`, line: 'f-ward', stock: 'toronto-ferry', cars: 1,
    dest: "Ward's Island", dir: 'Outbound',
    legs: [
      { s: 'tor:ferry-city', arr: t * 60 - 900, dep: t * 60 },
      { s: 'tor:ferry-wards', arr: (t + 15) * 60, dep: (t + 15) * 60 },
    ],
  });
  ferryRuns.push({
    id: `ferry-ward-${hh}${mm}r`, line: 'f-ward', stock: 'toronto-ferry', cars: 1,
    dest: 'Jack Layton Ferry Terminal', dir: 'Inbound',
    legs: [
      { s: 'tor:ferry-wards', arr: (t + 15) * 60 - 900, dep: (t + 15) * 60 },
      { s: 'tor:ferry-city', arr: (t + 30) * 60, dep: (t + 30) * 60 },
    ],
  });
}
// --- Billy Bishop ferry: ONE boat shuttling, exact schedule (user-supplied 2026-10-25) ---
// Mainland deps 05:15–00:00 every 15 min; island deps 05:22–00:07 every 15 min; 90 s crossing.
// Legs alternate docks: mainland dep -> 90 s water -> dwell at island slip -> island dep -> 90 s
// water -> dwell at mainland -> repeat. The 7-min schedule gap is crossing + dwell/turnaround, and
// the boat is visible during dwells because the whole day is a single run (not per-crossing runs
// that would make it vanish between trips). Service window 05:15–00:07 daily.
const S = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;
const bbLegs: Leg[] = [{ s: 'tor:bb-city', arr: S(5, 15), dep: S(5, 15) }];
for (let t = 5 * 60 + 15; t <= 24 * 60; t += 15) {
  // t = mainland departure, in minutes. Island arrival 90 s later; island departure 7 min after.
  bbLegs.push({ s: 'tor:bb-airport', arr: t * 60 + 90, dep: (t + 7) * 60 });
  if (t + 15 <= 24 * 60) {
    bbLegs.push({ s: 'tor:bb-city', arr: (t + 7) * 60 + 90, dep: (t + 15) * 60 });
  } else {
    // Final arrival at mainland after the last island departure (00:07); the run ends here.
    bbLegs.push({ s: 'tor:bb-city', arr: (t + 7) * 60 + 90, dep: (t + 7) * 60 + 90 });
  }
}
const bbShuttle: Run = {
  id: 'bb-shuttle', line: 'f-bb', stock: 'toronto-bbferry', cars: 1,
  dest: 'Billy Bishop Ferry', dir: 'Shuttle', legs: bbLegs,
};

// --- UP Express: every 15 min each way, 28-min run (official schedule; Mount Dennis is the
// fifth station, opened 2025-11-16). Union -> Bloor 8 min, Bloor -> Mount Dennis 4 min,
// Mount Dennis -> Weston 4 min, Weston -> Pearson 9 min (and reverse, mirrored). ---
const upRuns: Run[] = [];
for (let t = 5 * 60 + 30; t <= 23 * 60 + 45; t += 15) {
  const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
  upRuns.push({
    id: `up-u-${hh}${mm}`, line: 'up', stock: 'toronto-up', cars: 2,
    dest: 'Pearson Airport', dir: 'Westbound',
    legs: [
      { s: 'tor:up-union', arr: t * 60 - 300, dep: t * 60 },
      { s: 'tor:up-bloor', arr: (t + 8) * 60, dep: (t + 9) * 60 },
      { s: 'tor:up-mount-dennis', arr: (t + 13) * 60, dep: (t + 14) * 60 },
      { s: 'tor:up-weston', arr: (t + 18) * 60, dep: (t + 19) * 60 },
      { s: 'tor:up-pearson', arr: (t + 28) * 60, dep: (t + 28) * 60 },
    ],
  });
  upRuns.push({
    id: `up-p-${hh}${mm}`, line: 'up', stock: 'toronto-up', cars: 2,
    dest: 'Union Station', dir: 'Eastbound',
    legs: [
      { s: 'tor:up-pearson', arr: t * 60 - 300, dep: t * 60 },
      { s: 'tor:up-weston', arr: (t + 9) * 60, dep: (t + 10) * 60 },
      { s: 'tor:up-mount-dennis', arr: (t + 14) * 60, dep: (t + 15) * 60 },
      { s: 'tor:up-bloor', arr: (t + 19) * 60, dep: (t + 20) * 60 },
      { s: 'tor:up-union', arr: (t + 28) * 60, dep: (t + 28) * 60 },
    ],
  });
}

export const createTorontoSimAdapters: AdapterFactory = (env) => {
  // UP Express: official GTFS-RT overlay when a key is configured, timetable fallback otherwise.
  // Same adapter id either way, so live trains REPLACE (never duplicate) sim trains: matched
  // live trains reuse the sim run id, and only unmatched sim runs stay simulated.
  const upRt = new UpRtOverlay(env.METROLINX_API_KEY);
  const upAdapter: Adapter = {
    id: 'toronto-up',
    city: 'toronto',
    get name() { return upRt.hasLive ? 'UP Express · GTFS-RT' : 'UP Express · timetable'; },
    get live() { return upRt.hasLive; },
    intervalMs: 30_000,
    poll: async (now) => {
      const sim = trainsNow(upRuns, now);
      await upRt.refresh(now);
      const live = upRt.liveTrains(upRuns, now);
      if (!live.length) return sim;
      const liveIds = new Set(live.map((t) => t.id));
      return [...live, ...sim.filter((t) => !liveIds.has(t.id))];
    },
  };
  return [
    simAdapter('toronto-ferry', 'Toronto Island Ferry · timetable', [...ferryRuns, bbShuttle]),
    upAdapter,
  ];
};
