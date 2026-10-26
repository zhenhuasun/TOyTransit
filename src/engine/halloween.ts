// One-time Halloween easter egg (Oct 2026). Temporary by design: the date gate
// below guarantees the mode turns off after Nov 2, 2026 (America/Toronto), and
// this whole module is meant to be deleted once the egg is retired.
import type { SkyStyle } from '../themes/themes.ts';

/** Last Toronto calendar day the Halloween egg is available. */
export const HALLOWEEN_LAST_DAY = '2026-11-02';

/** Toronto wall-clock date (YYYY-MM-DD) for an instant, independent of the host zone. */
export function torontoDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Pure date gate: true while the Toronto calendar day is on or before
 * HALLOWEEN_LAST_DAY. There is deliberately no start bound — the egg exists
 * from the moment it ships until the end of Nov 2, 2026 Toronto time.
 */
export function isHalloweenWindow(d: Date): boolean {
  return torontoDate(d) <= HALLOWEEN_LAST_DAY;
}

/** Fixed dusk palette forced at ALL hours while Halloween mode is on. */
export const HALLOWEEN_SKY: SkyStyle = {
  top: '#1e0a3c',
  bottom: '#ff7a1a',
  sun: '#ffb347',
  sunI: 1.2,
  hemiSky: '#8b5cf6',
  hemiGround: '#3a1a10',
  hemiI: 1.3,
  shadows: true,
  stars: true,
};

const STORAGE_KEY = 'toytransit-halloween';

/** In-memory fallback when localStorage is unavailable (private mode etc). */
let sessionOn: boolean | null = null;

function storedOn(): boolean {
  if (sessionOn !== null) return sessionOn;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Effective mode: stored preference AND inside the date window. */
export function isHalloweenOn(): boolean {
  return storedOn() && isHalloweenWindow(new Date());
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onHalloweenChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setHalloween(on: boolean): void {
  sessionOn = on;
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode etc: the in-memory value above still applies this session.
  }
  for (const cb of [...listeners]) cb();
}

/**
 * The sky style that should be active given the theme's own style: the
 * Halloween palette wins while the mode is on, otherwise the theme's style.
 * All sky assignments (toggle, theme switch, expiry revert) go through here
 * so the mode can never leak into normal mode or vice versa.
 */
export function currentSkyStyle(themeStyle: SkyStyle | null): SkyStyle | null {
  return isHalloweenOn() ? HALLOWEEN_SKY : themeStyle;
}
