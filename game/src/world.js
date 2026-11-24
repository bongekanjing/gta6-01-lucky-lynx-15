// All mutable state for one session, in one object, plus the spawners that fill it. Nothing here
// draws and nothing here reads input: the systems in ai.js / physics.js move these records, the
// renderer reads them, and main.js decides when reset() runs. Deterministic: every random draw
// comes from state.rng, seeded from the city seed.
import { FOOT, PALETTE, VEHICLES, VEHICLE_PAINT, WEAPONS, WANTED, WORLD } from './config.js';
import { createRandom, rand, randInt, pick, clamp, TAU } from './util.js';

const CELL = WORLD.cell;
const ROAD = WORLD.road;
const SIDEWALK = 22;

let nextId = 1;
const uid = () => nextId++;

/** Vehicles sit 18 units off the street centre; the road is 76 wide so a lane each way fits. */
export const LANE = 17;

export function createWorld(city) {
  const state = {
    city,
    rng: createRandom(city.seed ^ 0x51ed270b),
    clock: 0,
    frame: 0,
    paused: false,

    player: null,
    cars: [],
    peds: [],
    cops: [],
    bullets: [],
    pickups: [],
    particles: [],
    skids: [],
    floaters: [],
    events: [],

    camera: { x: 0, y: 0, zoom: 0.84, shake: 0, shakeAng: 0 },
    weather: { rain: 0.55, drift: 0 },
    world: { time: 0 },

    places: {},
    objective: null,
    banner: null,
    toast: null,

    stats: { kills: 0, carsStolen: 0, missionDone: 0, distance: 0 },
    lastCrimeAt: -99,
    time: 0,
  };

  const P = FOOT;

  function makePlayer(x, y) {
    return {
      id: uid(), x, y, vx: 0, vy: 0, angle: -Math.PI / 2,
      health: P.maxHealth, armour: 0, money: 500,
      wanted: 0, heat: 0, wantedTimer: 0, seenTimer: 0,
      weapon: 'sidearm',
      ammo: { sidearm: Infinity, smg: 0, shotgun: 0 },
      car: null, inCar: false,
      fireCd: 0, meleeCd: 0, reload: 0,
      dead: false, deadTimer: 0, invuln: P.respawnInvuln,
      aiming: false, sprint: false, recoil: 0, walkPhase: 0, hurtFlash: 0,
      hasWeapon: { sidearm: true, smg: false, shotgun: false },
    };
  }

  function reset(keepProgress) {
    const prev = keepProgress && state.player ? {
      money: state.player.money, health: state.player.health, armour: state.player.armour,
      ammo: { ...state.player.ammo }, weapon: state.player.weapon,
      hasWeapon: { ...state.player.hasWeapon },
    } : null;

    state.rng = createRandom(city.seed ^ 0x51ed270b);
    state.clock = 0;
    state.frame = 0;
    state.cars.length = 0;
    state.peds.length = 0;
    state.cops.length = 0;
    state.bullets.length = 0;
    state.pickups.length = 0;
    state.particles.length = 0;
    state.skids.length = 0;
    state.floaters.length = 0;
    state.events.length = 0;
    state.stats = { kills: 0, carsStolen: 0, missionDone: 0, distance: 0 };
    state.lastCrimeAt = -99;
    state.objective = null;
    state.banner = null;
    state.toast = null;

    // Landmarks: the hospital, the precinct, the lock-up and the pier all get a spot on the grid.
    const bx = (i, j) => ({ x: i * CELL + CELL / 2, y: j * CELL + CELL / 2, i, j });
    state.places = {
      hospital: bx(2, 9),
      precinct: bx(6, 2),
      garage: bx(3, 6),
      pier: { x: city.pier.x + 60, y: city.pier.y + city.pier.h / 2, i: 10, j: 5 },
      park: { x: city.parkBlock.x + city.parkBlock.w / 2, y: city.parkBlock.y + city.parkBlock.h / 2, i: 1, j: 6 },
      docks: bx(9, 8),
    };

    const spawn = state.places.garage;
    state.player = makePlayer(spawn.x + 20, spawn.y - 60);
    // Start on a street: put the player on the sidewalk south of the lock-up.
    state.player.x = spawn.x + 40;
    state.player.y = spawn.y + 118;

    if (prev) {
      Object.assign(state.player, {
        money: prev.money, health: prev.health, armour: prev.armour,
        ammo: prev.ammo, weapon: prev.weapon, hasWeapon: prev.hasWeapon,
      });
    }

    state.camera.x = state.player.x;
    state.camera.y = state.player.y;

    fillTraffic(state, 26);
    fillPeds(state, 54);
    seedPickups(state);
    return state;
  }

  return { state, reset };
}

/* ------------------------------------------------------------------ vehicles */

export function makeCar(state, type, x, y, angle, opts = {}) {
  const spec = VEHICLES[type];
  const cam = opts.color ?? pick(state.rng, VEHICLE_PAINT[type] ?? ['#31374a']);
  const car = {
    id: uid(), type, spec,
    x, y, angle,
    vx: 0, vy: 0,
    speed: 0,
    steer: 0,
    wheel: 0,
    color: cam,
    health: spec.health,
    maxHealth: spec.health,
    police: type === 'police' || type === 'swat',
    stolen: !!opts.stolen,
    wrecked: false,
    driver: opts.driver ?? null,
    driverLost: false,
    brake: false,
    siren: type === 'police' || type === 'swat',
    sirenPhase: 0,
    // Lane-rail driving, used by traffic and cops until the player takes the wheel.
    rail: opts.rail ?? null,
    axis: 'h',
    dir: 1,
    laneShift: 0,
    railSpeed: opts.railSpeed ?? 0,
    stuck: 0,
    honk: 0,
    smokeTimer: 0,
    bulletHoles: [],
    engine: 0,
    blip: 0,
  };
  state.cars.push(car);
  return car;
}

/** Snap a rail car onto a lane: dir 1 = east/south, -1 = west/north. */
export function laneOffset(axis, dir) {
  return axis === 'h' ? dir * LANE : -dir * LANE;
}

/** Put a car on the nearest road, heading in `dir` along `axis`, in its own lane. */
export function placeOnRoad(state, car, axis, dir, speed) {
  car.axis = axis;
  car.dir = dir;
  car.laneShift = 0;
  car.railSpeed = speed;
  if (axis === 'h') {
    const gy = Math.round(car.y / CELL) * CELL;
    car.y = gy + laneOffset('h', dir);
    car.x = Math.round(car.x);
    car.angle = dir > 0 ? 0 : Math.PI;
  } else {
    const gx = Math.round(car.x / CELL) * CELL;
    car.x = gx + laneOffset('v', dir);
    car.y = Math.round(car.y);
    car.angle = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  car.vx = Math.cos(car.angle) * speed;
  car.vy = Math.sin(car.angle) * speed;
}

export function setRail(state, car, axis, dir) {
  placeOnRoad(state, car, axis, dir, car.railSpeed || 120);
}

/* ------------------------------------------------------------------ spawners */

/** Is any car within `d` of (x,y)? Used to avoid spawning on top of the player. */
function carNear(state, x, y, d) {
  for (let i = 0; i < state.cars.length; i += 1) {
    const c = state.cars[i];
    if (Math.abs(c.x - x) < d && Math.abs(c.y - y) < d) return true;
  }
  return false;
}

export function fillTraffic(state, count) {
  const p = state.player;
  let placed = 0;
  let guard = 0;
  const types = ['sedan', 'sedan', 'sedan', 'taxi', 'van', 'sports', 'muscle'];
  while (placed < count && guard < count * 30) {
    guard += 1;
    const axis = state.rng() < 0.5 ? 'h' : 'v';
    const dir = state.rng() < 0.5 ? 1 : -1;
    const street = randInt(state.rng, 0, WORLD.grid);
    const along = rand(state.rng, 0, WORLD.size);
    const x = axis === 'h' ? along : street * CELL;
    const y = axis === 'h' ? street * CELL : along;
    if (carNear(state, x, y, 140)) continue;
    if (p && Math.hypot(p.x - x, p.y - y) < 420) continue;
    const car = makeCar(state, pick(state.rng, types), x, y, 0, {
      rail: true, railSpeed: rand(state.rng, 78, 132),
    });
    placeOnRoad(state, car, axis, dir, car.railSpeed);
    car.driver = { ped: 'npc' };
    placed += 1;
  }
}

export function spawnPed(state, x, y, opts = {}) {
  const kind = opts.kind ?? 'civilian';
  // Faction reads off colour before anything else at this scale: crew wear the same oxblood
  // windbreakers so a firefight never leaves you guessing who is shooting at you.
  const crew = kind === 'thug' || kind === 'boss';
  const p = {
    id: uid(), x, y, vx: 0, vy: 0, angle: rand(state.rng, 0, TAU),
    speed: 0, walkSpeed: rand(state.rng, 34, 52),
    health: 30, panicked: 0, dead: false, deadTimer: 0,
    target: null, block: opts.block ?? -1, corner: randInt(state.rng, 0, 3),
    colour: crew
      ? pick(state.rng, ['#6b1f2c', '#7a2430', '#5e1a26', '#83302c'])
      : pick(state.rng, ['#39405a', '#4a3d52', '#2f4a4a', '#514038', '#3b3550', '#2b3f3a', '#4d2f3f', '#3a4258']),
    skin: pick(state.rng, ['#c99a76', '#8e6247', '#e0b491', '#6d4534', '#b9805e']),
    hat: crew ? state.rng() < 0.45 : state.rng() < 0.25,
    bag: !crew && state.rng() < 0.3,
    phase: rand(state.rng, 0, TAU),
    hurt: 0,
    kind,
  };
  state.peds.push(p);
  return p;
}

/** Sidewalks: the perimeter of a block, inset from the kerb. */
export function sidewalkPoint(block, t) {
  const x = block.x + block.w / 2;
  const y = block.y + block.h / 2;
  const rx = block.w / 2 - 10;
  const ry = block.h / 2 - 10;
  const per = 2 * (rx + ry);
  let d = t % per;
  if (d < rx * 2) return { x: x - rx + d, y: y - ry };
  d -= rx * 2;
  if (d < ry * 2) return { x: x + rx, y: y - ry + d };
  d -= ry * 2;
  if (d < rx * 2) return { x: x + rx - d, y: y + ry };
  d -= rx * 2;
  return { x: x - rx, y: y + ry - d };
}

export function fillPeds(state, count) {
  const blocks = state.city.blocks.filter((b) => !b.park);
  for (let i = 0; i < count; i += 1) {
    const block = blocks[randInt(state.rng, 0, blocks.length - 1)];
    const pt = sidewalkPoint(block, rand(state.rng, 0, 900));
    spawnPed(state, pt.x, pt.y, { block: state.city.blocks.indexOf(block) });
  }
}

export function seedPickups(state) {
  const add = (x, y, kind, value) => state.pickups.push({ id: uid(), x, y, kind, value, bob: rand(state.rng, 0, TAU), taken: false, respawn: 0 });
  const h = state.places.hospital;
  add(h.x - 90, h.y + 120, 'health', 40);
  add(h.x - 90, h.y + 150, 'health', 40);
  const pr = state.places.precinct;
  add(pr.x + 110, pr.y + 130, 'armour', 50);
  add(pr.x + 140, pr.y + 130, 'armour', 50);
  const g = state.places.garage;
  add(g.x + 40, g.y + 150, 'ammo', 40);
  add(g.x + 70, g.y + 150, 'cash', 250);
  const park = state.places.park;
  add(park.x, park.y + 70, 'cash', 400);
  add(park.x - 60, park.y - 40, 'health', 30);
  const d = state.places.docks;
  add(d.x - 40, d.y + 140, 'cash', 320);
  add(d.x + 20, d.y + 140, 'armour', 50);
  add(state.places.pier.x, state.places.pier.y + 70, 'ammo', 60);
}

/** Police: a car + two officers, spawned on a street near the player but out of sight. */
export function spawnPolice(state, wanted) {
  const p = state.player;
  const rng = state.rng;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ang = rand(rng, 0, TAU);
    const r = rand(rng, 620, 980);
    const x = p.x + Math.cos(ang) * r;
    const y = p.y + Math.sin(ang) * r;
    if (x < 40 || y < 40 || x > state.city.size - 40 || y > state.city.size - 40) continue;
    const axis = Math.abs(Math.cos(ang)) > Math.abs(Math.sin(ang)) ? 'v' : 'h';
    const dir = rng() < 0.5 ? 1 : -1;
    const car = makeCar(state, wanted >= 4 && rng() < 0.4 ? 'swat' : 'police', x, y, 0, { rail: true, railSpeed: 190 });
    placeOnRoad(state, car, axis, dir, 170);
    car.driver = { npc: true };
    car.pursuit = true;
    state.cops.push({ id: uid(), mode: 'car', car, health: 90, shootCd: 0, x, y, angle: 0, state: 'drive', footTarget: null });
    return car;
  }
  return null;
}

/* ------------------------------------------------------------------ effects */

export function addParticles(state, x, y, count, opts = {}) {
  const { rng } = state;
  for (let i = 0; i < count; i += 1) {
    const a = opts.angle ?? rand(rng, 0, TAU);
    const spread = opts.spread ?? TAU;
    const ang = a + rand(rng, -spread / 2, spread / 2);
    const sp = rand(rng, opts.minSpeed ?? 40, opts.maxSpeed ?? 220);
    state.particles.push({
      x, y,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      life: rand(rng, opts.minLife ?? 0.2, opts.maxLife ?? 0.6),
      maxLife: 0.6,
      size: rand(rng, opts.minSize ?? 1.2, opts.maxSize ?? 3.2),
      colour: opts.colour ?? PALETTE.neonAmber,
      drag: opts.drag ?? 3.2,
      glow: opts.glow ?? true,
      kind: opts.kind ?? 'spark',
    });
  }
}

export function addFloater(state, x, y, text, colour) {
  state.floaters.push({ x, y, text, colour, life: 1.4, vy: -26 });
}

export function addSkid(state, x, y, angle, strength) {
  if (state.skids.length > 900) state.skids.splice(0, 60);
  state.skids.push({ x, y, angle, life: 14, alpha: 0.5 * strength });
}

export function pushEvent(state, name, data) {
  state.events.push({ name, data });
}

/** Point the camera at the player (or their car), with a bit of look-ahead. */
export function updateCamera(state, dt) {
  const p = state.player;
  const cam = state.camera;
  const focus = p.inCar && p.car ? p.car : p;
  const speed = p.inCar && p.car ? Math.hypot(p.car.vx, p.car.vy) : Math.hypot(p.vx, p.vy);
  const lead = p.inCar && p.car ? 0.42 : 0.2;
  const tx = focus.x + (focus.vx ?? 0) * lead / 8 + Math.cos(focus.angle ?? 0) * speed * 0.09;
  const ty = focus.y + (focus.vy ?? 0) * lead / 8 + Math.sin(focus.angle ?? 0) * speed * 0.09;
  cam.x += (tx - cam.x) * (1 - Math.exp(-7 * dt));
  cam.y += (ty - cam.y) * (1 - Math.exp(-7 * dt));
  const wantZoom = p.inCar ? clamp(0.9 - speed / 2600, 0.72, 0.94) : 0.94;
  cam.zoom += (wantZoom - cam.zoom) * (1 - Math.exp(-3 * dt));
  cam.shake = Math.max(0, cam.shake - dt * 26);
}

/** The car the player is closest to and facing, within reach. */
export function carInReach(state) {
  const p = state.player;
  let best = null;
  let bestD = 70;
  for (let i = 0; i < state.cars.length; i += 1) {
    const c = state.cars[i];
    if (c.wrecked) continue;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export const WEAPON_TABLE = WEAPONS;
export const SIDEWALK_WIDTH = SIDEWALK;
export const ROAD_HALF = ROAD / 2;
