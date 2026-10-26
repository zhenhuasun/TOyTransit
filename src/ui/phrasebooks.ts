import type { CityId, LineDef } from '../../shared/types.ts';
import type { RollingStyle } from './sound.ts';

// Announcements for the newer cities, each in the city's own language and in the spirit of how its trains
// actually talk. Phrasing and chimes are our own; set phrases like "Mind the gap" are what riders hear.

export interface Say {
  line: LineDef;
  /** Destination and next/current station, in English and in the local script (same when it's the same). */
  dest: string;
  destL: string;
  stop: string;
  stopL: string;
  /** Other lines at this station (for approach/arrival). */
  transfers: LineDef[];
}

export interface Phrasebook {
  lang: string;
  intro: (s: Say) => string;
  /** Said ~15 s before arriving; empty for systems that stay quiet. */
  approach: (s: Say) => string;
  /** Said on arrival at an intermediate stop (optional). */
  arrive?: (s: Say) => string;
  terminal: (s: Say) => string;
  /** Spoken as the doors close; `stop` is the next station. */
  doors?: (s: Say) => string;
  /** Door chime: semitones above C5, played in sequence. */
  chime: number[];
  chimeStep?: number;
  chimeKind?: 'bell' | 'beep';
  /** Seconds before departure that the doors start closing. */
  lead?: number;
  /** Systems that name the next stop as the doors close (Moscow) don't repeat it after departure. */
  quietDepart?: boolean;
  roll: RollingStyle;
}

const local = (l: LineDef) => l.nameLocal ?? l.name;
const short = (l: LineDef) => l.short || l.name;
const and = (xs: string[], word: string) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`);
const uniq = (xs: string[]) => [...new Set(xs)];

const METRO: RollingStyle = { rumble: 0.85, roar: 0.7, whine: 1, clack: 0.7, carLen: 19 };
const HEAVY: RollingStyle = { rumble: 0.9, roar: 0.8, whine: 0.9, clack: 0.8, carLen: 22 };
const LIGHT: RollingStyle = { rumble: 0.5, roar: 0.1, whine: 0.8, clack: 0.5, carLen: 12 };
const OLD: RollingStyle = { rumble: 1, roar: 1, whine: 0.7, clack: 1, carLen: 19 };

const mandarin: Phrasebook = {
  lang: 'zh-CN',
  intro: (s) => `本次列车开往${s.destL}。下一站，${s.stopL}。`,
  approach: (s) => `下一站，${s.stopL}。${s.transfers.length ? `可换乘${uniq(s.transfers.map(local)).join('、')}。` : ''}`,
  arrive: (s) => `${s.stopL}到了。`,
  terminal: (s) => `终点站，${s.stopL}，到了。请全体乘客下车，带好您的随身物品。`,
  doors: () => '车门即将关闭，请注意安全。',
  chime: [16, 16, 16, 16, 16, 16],
  chimeStep: 0.2,
  chimeKind: 'beep',
  lead: 6,
  roll: METRO,
};

const english = (o: Partial<Phrasebook> & Pick<Phrasebook, 'intro' | 'approach' | 'terminal' | 'chime'>): Phrasebook => ({ lang: 'en-US', roll: HEAVY, ...o });

// Toronto (TTC): English only — the TTC does not announce in French. Subway and
// LRT talk in stations, streetcars and buses in stops; ferries and UP Express
// stay quiet (they are not TTC). Phrasing is our own, in the spirit of what
// riders hear. The spoken lines branch on line.system because the phrasebook
// is city-wide: anything that is not subway/LRT/streetcar/bus returns '' and
// the soundscape's lang() helper skips empty strings, so it stays silent.
const sayName = (n: string) =>
  n
    .replace(/\bSt (George|Andrew|Patrick|Clair)\b/g, 'Saint $1')
    .replace(/\bSt\b\.?/g, 'Street')
    .replace(/Yonge/g, 'Young')
    .replace(/\bVaughan\b/g, 'Vawn');

const isRail = (s: Say) => s.line.system === 'subway' || s.line.system === 'lrt';
const isSurface = (s: Say) => s.line.system === 'streetcar' || s.line.system === 'bus';
const railTransfers = (s: Say) =>
  uniq(s.transfers.filter((l) => l.system === 'subway' || l.system === 'lrt').map((l) => `Line ${l.short}`));

const toronto: Phrasebook = english({
  intro: (s) => {
    if (!isRail(s) && !isSurface(s)) return '';
    const stop = sayName(s.stop);
    const dest = sayName(s.dest);
    return isRail(s)
      ? `This train is bound for ${dest}. The next station is ${stop}.`
      : `This is the ${s.line.name} to ${dest}. Next stop, ${stop}.`;
  },
  approach: (s) => {
    if (!isRail(s) && !isSurface(s)) return '';
    const stop = sayName(s.stop);
    if (!isRail(s)) return `Next stop, ${stop}.`;
    const tr = railTransfers(s);
    return `The next station is ${stop}.${tr.length ? ` Change here for ${and(tr, 'and')}.` : ''}`;
  },
  arrive: (s) => {
    if (!isRail(s) && !isSurface(s)) return '';
    const stop = sayName(s.stop);
    return isRail(s) ? `${stop} station.` : `${stop}.`;
  },
  terminal: (s) => {
    if (!isRail(s) && !isSurface(s)) return '';
    const stop = sayName(s.stop);
    return isRail(s)
      ? `This is ${stop} station. This train terminates here. Please exit the train and take all your belongings with you.`
      : `This is ${stop}, the last stop. Please exit the vehicle.`;
  },
  doors: (s) => (isRail(s) ? 'Please stand clear of the doors.' : ''),
  // Pleasant ascending bell triad (E5–G5–C6). Note: the book path plays this
  // city-wide chime on every doorsClosing, so surface vehicles and ferries
  // hear the chime too — only the spoken line is suppressed per system.
  chime: [4, 7, 12],
  chimeKind: 'bell',
  quietDepart: false,
});

export const PHRASEBOOKS: Partial<Record<CityId, Phrasebook>> = { toronto };
