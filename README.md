# TOyTransit

**Live at [toronto-toy-map.zhenhuasun.workers.dev](https://toronto-toy-map.zhenhuasun.workers.dev)**

A real-time toy map of Toronto transit — a map a child can read is a map anyone can read.

Toronto is a little floating island, built from real geography. The trains, streetcars and buses are
real vehicles, placed from live feeds and animated along the actual track. Each one is a procedural
model of its real rolling stock, with its livery painted by hand in code. The sun, moon, stars and
weather match Toronto right now. At night the windows light up.

## What you see

- **TTC subway** — lines 1, 2 and 4, live from the TTC's official GTFS-realtime trip updates
- **TTC streetcars and buses** — live vehicle positions from the same feed
- **LRT lines 5 and 6** — timetable-simulated (no live feed exists for them)
- **Toronto Island Ferry and Billy Bishop ferry** — timetable-simulated
- **UP Express** — all five stations (Union, Bloor, Mount Dennis, Weston, Pearson), live when a
  Metrolinx API key is configured, timetable-simulated otherwise
- **Live flights** over Billy Bishop (YTZ) and Pearson (YYZ), from keyless ADS-B

Tunnels are drawn dim with a dashed centreline, and trains inside them go ghost — pale and
translucent — until they come out through a concrete portal frame. Streetcars run on grooved rail,
flush with the pavement. Elevated sections climb real ramps, and each car pitches to the slope.

## Themes

The live data and the map are one model; how they're drawn is a theme. Pick one from the Theme
menu under the logo (or press `V`), or add `?theme=` to any link. There are twelve: Toy, Clay,
Blueprint, NYC Subway, Neon, Pixel, Voxel, Monet, Cubism, Noir, Circuit and Cel Shaded.

A theme is a *look*, not a filter: every material (ground, water, roads, buildings, houses, trees,
lines, trains) reads its palette and treatment from one set of shared uniforms
(`src/themes/look.ts`), so the style is applied where each thing is drawn and the information
hierarchy survives — trains and lines keep their true colors. Switching themes is instant;
nothing is reloaded.

## How it works

- The client (`src/`, Three.js) animates each vehicle along the real track geometry between
  timeline stops. Motion follows a speed-bounded, no-reversing model, so vehicles glide smoothly
  between polls. When ETAs slip, a vehicle holds in place as if waiting at a signal.
- Geography (`public/data/toronto/geo.json`, `buildings.bin`, `density.bin`) is baked from
  OpenFreeMap vector tiles: water, parks, roads, rail, building footprints as oriented boxes, and
  a density raster that fills the suburbs with little houses.
- The transit network and schedules (`public/data/toronto/transit.json`) are baked from the City
  of Toronto's open GTFS feed, projected into local metres.
- Production is a single Cloudflare Worker (`toronto-toy-map`, `worker/main.ts`) with a Durable
  Object (`CityHub`) that polls the live feeds; the static data files are bundled into the Worker.

## Run it

```bash
npm install
npm run dev          # API server + Vite app
```

```bash
npm run deploy       # build + deploy the Worker
npx wrangler secret put METROLINX_API_KEY   # makes UP Express live; without it, UP runs on timetable
```

A plain Node server works too: `npm run build && npm start`.

## Live data

| Mode | Live source | When it is not live |
|---|---|---|
| TTC subway, streetcar, bus | TTC GTFS-realtime (`gtfsrt.ttc.ca`) | NextBus fallback, then timetable |
| UP Express | Metrolinx API (`api.openmetrolinx.com`) | Timetable (no key configured, or the key has no UP capability) |
| Flights | Keyless ADS-B (`adsb.lol`, `adsb.fi`) | — |
| LRT 5/6, ferries | — | Always timetable-simulated; no public live feed exists |

Vehicles marked **timetable** in the UI come from official timetables, used where no public live
feed exists or where a key isn't configured. Everything else is live.

Timetable data goes stale: rebuild it with `npm run data:toronto` when the City of Toronto
publishes a new GTFS feed, and re-bake the geography with `npm run data:geo` when the map needs it.

```bash
npm run data         # transit network + geography
npm run check        # run the live adapters once and print sanity stats
```

## Controls

Drag to pan · scroll or pinch to zoom · right-drag (or two-finger twist) to rotate · click a
vehicle or station.

Keys: `Q/E` rotate · `F` follow (ride along) · `R` surprise train · `T` tour · `G` fleet guide ·
`L` sky (live / night / day) · `A` live planes · `V` theme · `M` sound · `S` share ·
`P` save a postcard · `N` reset view · `/` or `⌘K` search · `H` hide the interface ·
`,` settings · `Esc` close

Every train, line and station selection has a shareable URL, and each URL gets its own preview
card when pasted into a chat.

Things to try:

- **Tap a vehicle** to see its next stops with live ETAs. A dashed ribbon traces the track
  ahead, and flags pop up over the next stations.
- **Follow** a vehicle: the camera rides alongside it. Turn on sound (`M`) for a door chime at
  each station, and Toronto station announcements.
- **Tap a station** for a departures board.
- **Tap a line in the legend** to highlight it: its tracks stay bold, everything else fades, the
  camera frames the line and every vehicle on it gets a pin.
- **Tour** (`T`) drifts from vehicle to vehicle across the city; it starts by itself if you leave
  the map alone.
- Zoom out to see the whole city as a floating island, with Lake Ontario along the bottom.

## Data credits

The data files in `public/data/` are derived from the sources below and stay under their licenses:
geography and many track shapes from OpenStreetMap (© OpenStreetMap contributors, ODbL), transit
networks and timetables from the City of Toronto's open data under its terms.

Transit data: City of Toronto Open Data, TTC, Metrolinx. Map data © OpenStreetMap contributors,
OpenMapTiles, OpenFreeMap. Weather: Open-Meteo.
