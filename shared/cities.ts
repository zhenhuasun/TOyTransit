import type { CityId } from './types.ts';

export interface CityConfig {
  id: CityId;
  name: string;
  nameLocal?: string;
  country: string;
  tz: string; // IANA timezone
  /** Projection origin [lon, lat]. */
  origin: [number, number];
  /** Diorama extent in lon/lat: [west, south, east, north]. */
  bbox: [number, number, number, number];
  /** Initial camera: center [lon, lat] and visible span in meters. */
  view: { center: [number, number]; span: number };
  tagline: string;
}

export const CITIES: Record<CityId, CityConfig> = {
  toronto: {
    id: 'toronto',
    name: 'Toronto',
    country: 'Canada',
    tz: 'America/Toronto',
    origin: [-79.385, 43.65],
    bbox: [-79.75, 43.58, -79.10, 43.86],
    view: { center: [-79.385, 43.66], span: 2800 },
    tagline: 'TTC, Island Ferries, UP Express & live planes',
  },
};

/** Toronto only. */
export const CITY_ORDER: CityId[] = [
  'toronto',
];
