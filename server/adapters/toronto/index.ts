// Toronto adapters: TTC via the GTFS kit timetable + the official TTC GTFS-RT overlay
// (ttc-rt.ts: surface vehicle positions + subway arrival predictions, NextBus fallback), plus
// timetable-simulated ferries and UP Express (timetable.ts + the official Metrolinx GTFS-RT
// overlay in up-rt.ts when a key is configured, timetable fallback otherwise).
// LRT routes 5/6 have no RT feed and stay simulated.
import type { AdapterFactory } from '../types.ts';
import { gtfsAdapters } from '../gtfs/index.ts';
import { TtcRtSource } from './ttc-rt.ts';
import { createTorontoSimAdapters } from './timetable.ts';

export const createAdapters: AdapterFactory = (env) => {
  const ttc = new TtcRtSource();
  return [
    ...gtfsAdapters({
      city: 'toronto',
      schedule: 'server/data/toronto/schedule.json',
      adapters: [
        { id: 'toronto-subway', name: 'TTC Subway', systems: ['subway'], realtime: ttc },
        { id: 'toronto-streetcar', name: 'TTC Streetcar', systems: ['streetcar'], realtime: ttc },
        { id: 'toronto-lrt', name: 'TTC LRT', systems: ['lrt'], realtime: ttc },
        { id: 'toronto-bus', name: 'TTC Bus', systems: ['bus'], realtime: ttc },
      ],
    }),
    ...createTorontoSimAdapters(env),
  ];
};
