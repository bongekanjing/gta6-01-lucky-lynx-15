# Neon Haven — an original open-world crime game

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/bongekanjing/gta6-01-lucky-lynx-15/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/bongekanjing/gta6-01-lucky-lynx-15/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

An entry for **make.fun gta6-01**. Neon Haven is a top-down 2.5D neon-noir crime
game written in plain JavaScript ES modules: a projected canvas city you walk on
foot and drive through, traffic and pedestrians, cars you can steal, a five-star
wanted level with police that chase and shoot, a five-mission story chain, a HUD
with a minimap, a start screen, and a saved game in `localStorage`.

Everything is drawn in code from a seed. There is no art file, no audio file, no
library and no network request at runtime.

## The city

A grid of blocks cut by roads and sidewalks, with buildings of varying height and
colour, streetlights, neon signs, a waterfront and a park. The layout comes from a
seeded generator, so the same seed always builds the same city.

## What the game does

- **On foot** — walk, sprint, aim with the mouse, shoot, melee, and press F to get
  into a car.
- **Driving** — arcade handling with acceleration, braking, speed-scaled steering,
  drift and collisions against buildings and other cars.
- **Traffic and pedestrians** — cars follow the road network and queue behind each
  other; pedestrians walk the sidewalks and scatter at gunfire.
- **Car theft** — walk up to a car, press F, and the driver is thrown out.
- **Wanted level** — 0 to 5 stars. Crime raises it, police spawn and give chase, and
  from three stars they shoot. Staying out of sight cools it down.
- **Combat** — travelling bullets, hit detection, health and armour, hospital
  respawn with a cash penalty.
- **Missions** — a chain of five missions with a story, markers, a HUD banner, a
  reward and a fail state.
- **HUD** — money, health, armour, wanted stars, a minimap of the city grid, the
  current objective, a speedometer and ammo.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `game/` and `screenshots/` to the output directory and writes
`dossier.json`. To play it locally instead:

```sh
node serve.ts
# then open http://localhost:8080
```

## Layout

```
game/index.html     the canvas and the module entry point
game/src/config.js  tunables: colours, speeds, sizes, spawn rates
game/src/util.js    maths, seeded rng, easing, geometry
game/src/city.js    city generation: blocks, roads, buildings, props
game/src/world.js   entity state: player, vehicles, peds, police, bullets, pickups
game/src/ai.js      traffic, pedestrian and police behaviour
game/src/physics.js movement, collisions, vehicle handling
game/src/missions.js the mission chain and its state machine
game/src/render.js  projection, depth sorting and drawing
game/src/hud.js     HUD, minimap, banners and menus
game/src/audio.js   WebAudio effects: guns, engines, sirens, pickups
game/src/shots.js   the fixed screenshot scenes
game/src/main.js    boot, the loop, input and save/load
main.ts             the program the grader runs
shots.json          the screenshot names and their query strings
screenshots/        four frames, the first being the cover
```

## Screenshots

`?shot=city|chase|mission|foot` sets up a fixed scene and renders one still frame
without waiting for input, so the captures are reproducible: `1-city` is the
cover, then `2-chase`, `3-mission` and `4-foot`.

## License

MIT. All art, names, story and sound in this game are original to this entry.
