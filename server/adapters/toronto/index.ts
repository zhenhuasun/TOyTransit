// Toronto adapters: TTC via the GTFS kit timetable + a shared NextBus live overlay, plus
// timetable-simulated ferries and UP Express. See bustime.ts for why the official GTFS-RT is not wired.
import type { AdapterFactory } from '../types.ts';
import { gtfsAdapters } from '../gtfs/index.ts';
import { NextBusSource } from './nextbus.ts';
import { createTorontoSimAdapters } from './timetable.ts';

export const createAdapters: AdapterFactory = (env) => {
  const nb = new NextBusSource();
  return [
    ...gtfsAdapters({
      city: 'toronto',
      schedule: 'server/data/toronto/schedule.json',
      adapters: [
        { id: 'toronto-subway', name: 'TTC Subway', systems: ['subway'], realtime: nb },
        { id: 'toronto-streetcar', name: 'TTC Streetcar', systems: ['streetcar'], realtime: nb },
        { id: 'toronto-lrt', name: 'TTC LRT', systems: ['lrt'], realtime: nb },
        { id: 'toronto-bus', name: 'TTC Bus', systems: ['bus'], realtime: nb },
      ],
    }),
    ...createTorontoSimAdapters(env),
  ];
};
