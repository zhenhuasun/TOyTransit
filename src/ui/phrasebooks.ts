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

export const PHRASEBOOKS: Partial<Record<CityId, Phrasebook>> = {};
