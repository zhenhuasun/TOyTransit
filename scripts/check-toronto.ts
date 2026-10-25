import { checkGtfsCity } from './lib/gtfs/check.ts';
import { createAdapters } from '../server/adapters/toronto/index.ts';
await checkGtfsCity('toronto', createAdapters);
