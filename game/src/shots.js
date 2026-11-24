// The four screenshot scenes behind ?shot=city|chase|mission|foot. Each one builds its scene from
// the real systems — the same city, the same traffic, the same police — then runs the world a
// fixed number of steps with a scripted driver so the frame is a moment from a game that is
// actually being played, not a diorama. All of it is deterministic per seed: no Math.random.
import { PALETTE, STEP, VEHICLES, WANTED } from './config.js';
import { addParticles, addSkid, makeCar, placeOnRoad, spawnPed, sidewalkPoint } from './world.js';
import { commitCrime } from './ai.js';
import { stepCarRail } from './physics.js';
import { money } from './util.js';

/** Advance only the traffic, so the streets are busy and spread out when the frame lands. */
function settleTraffic(state, seconds) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    state.clock += STEP;
    for (let c = 0; c < state.cars.length; c += 1) {
      const car = state.cars[c];
      if (car.rail && !car.parked && !car.wrecked) stepCarRail(state, car, STEP);
    }
  }
}

/** A road-following car near a point, facing the way we want. */
function carAt(state, type, x, y, axis, dir, speed, colour) {
  const car = makeCar(state, type, x, y, 0, { rail: true, railSpeed: speed, color: colour });
  placeOnRoad(state, car, axis, dir, speed);
  car.driver = { npc: true };
  return car;
}

function scatterPeds(state, cx, cy, count, radius) {
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + 0.7;
    const r = radius * (0.45 + ((i * 37) % 100) / 200);
    spawnPed(state, cx + Math.cos(a) * r, cy + Math.sin(a) * r, { block: 0 });
  }
}

/* ------------------------------------------------------------------ city */

function stageCity(state) {
  const { city } = state;
  // Street-level cover frame: the camera sits close enough that a person is 20px and a car is
  // 70px, so the frame reads as a street and not as a map. The avenue runs across the lower
  // third with traffic streaming toward us, the towers of Halcyon Spire stack up behind, and the
  // player stands on the near kerb with a stolen car idling beside them.
  const ix = 8 * city.cell;
  const iy = 3 * city.cell;
  // Composition: the camera looks north across the avenue, so the towers of Halcyon Spire stack
  // into the top two thirds (facades, window grids, neon) and the avenue cuts across the bottom
  // third. The player stands on the north kerb at roughly 68% height — the strongest third line —
  // with the stolen car beside them, so the frame has a subject and no dead rooftop.
  state.camera.x = ix - 20;
  state.camera.y = iy - 153;
  state.camera.zoom = 1.75;
  state.camera.shake = 0;
  state.weather.rain = 0.75;
  settleTraffic(state, 11);

  // The player on the north kerb, gun up, facing out across the avenue.
  state.player.x = ix - 118;
  state.player.y = iy - 58;
  state.player.angle = 1.35;
  state.player.car = null;
  state.player.inCar = false;
  state.player.aim = true;
  state.player.weapon = 'pistol';
  state.player.health = 84;

  // Hero car right of the player, nose angled into the frame, headlights on: the subject.
  const hero = makeCar(state, 'muscle', ix - 6, iy - 46, -0.42, { color: '#d8443f' });
  hero.rail = false;
  hero.parked = true;
  hero.vx = 0; hero.vy = 0;
  hero.lights = true;
  hero.stolen = true;
  hero.driver = null;

  // Traffic on the avenue: two lanes each way, staggered, headlights toward the camera.
  const lanes = [
    { y: iy - 17, dir: -1, types: ['taxi', 'sedan', 'sports', 'taxi', 'van'] },
    { y: iy - 54, dir: -1, types: ['sedan', 'muscle', 'taxi', 'sedan'] },
    { y: iy + 17, dir: 1, types: ['van', 'sedan', 'taxi', 'sports'] },
    { y: iy + 54, dir: 1, types: ['taxi', 'sedan', 'muscle'] },
  ];
  for (let li = 0; li < lanes.length; li += 1) {
    const lane = lanes[li];
    for (let i = 0; i < lane.types.length; i += 1) {
      const car = carAt(state, lane.types[i], ix - 250 + i * 150 + li * 60, lane.y, 'h', lane.dir, 96 + (i % 3) * 22);
      car.lights = true;
    }
  }

  // A cruiser on the corner, bar going, so the city reads as policed.
  const cruiser = carAt(state, 'police', ix + 60, iy + 40, 'h', 1, 0);
  cruiser.rail = false;
  cruiser.parked = true;
  cruiser.angle = 0.28;
  cruiser.vx = 0; cruiser.vy = 0;
  cruiser.driver = { npc: true };

  // Crowd on the pavements and in the road: people are what make the city feel inhabited.
  scatterPeds(state, ix - 40, iy + 96, 16, 120);
  scatterPeds(state, ix + 190, iy + 84, 12, 110);
  scatterPeds(state, ix + 40, iy - 96, 10, 100);

  // Wet reflections: skid-sheen streaks that catch the neon and the headlights.
  for (let i = 0; i < 20; i += 1) {
    addSkid(state, ix - 360 + i * 42, iy + 34 + (i % 4) * 14, 0.16 + i * 0.28, 0.34);
  }
  state.shotClean = true;
  state.shotTitle = false;
  state.objective = null;
  state.bannerText = null;
  state.missionBannerT = 0;
  state.stats.lives = 3;
  return 'city';
}

/* ------------------------------------------------------------------ chase */

function stageChase(state) {
  const { city } = state;
  const road = 6 * city.cell;
  const px = 3.1 * city.cell;
  const py = road - 17;

  // The player's car: a hot-magenta sports coupé. White was a mistake — at this bloom level a
  // white coupé reads as a cruiser. Magenta appears nowhere else on the road, so the hero car is
  // unmistakable and the black-and-white cruisers behind it read as police by contrast.
  const playerCar = makeCar(state, 'sports', px, py, 0, { color: '#ff2e6a' });
  placeOnRoad(state, playerCar, 'h', 1, 210);
  playerCar.driver = 'player';
  playerCar.rail = false;
  playerCar.steer = 0.28;
  playerCar.wheel = 14;
  playerCar.lights = true;
  playerCar.stolen = true;
  state.player.inCar = true;
  state.player.car = playerCar;
  state.player.x = playerCar.x;
  state.player.y = playerCar.y;

  // Two cruisers nose-to-tail right behind, plus one flanking in the oncoming lane so the chase
  // reads as a pursuit from every direction rather than a queue. Spacing is tight — a chase at
  // arm's length is the tension, not three cars cruising in formation.
  const specs = [
    { x: px - 56, y: py + 6, dir: 1 },
    { x: px - 116, y: py - 3, dir: 1 },
    { x: px + 38, y: road + 19, dir: -1 },
  ];
  for (let i = 0; i < specs.length; i += 1) {
    const s = specs[i];
    const cruiser = makeCar(state, 'police', s.x, s.y, 0, {});
    placeOnRoad(state, cruiser, 'h', s.dir, 208);
    cruiser.rail = false;
    cruiser.vx = 200 * s.dir;
    cruiser.vy = 0;
    cruiser.steer = s.dir > 0 ? 0.12 : -0.1;
    cruiser.wheel = 9;
    cruiser.lights = true;
    cruiser.driver = { npc: true };
    state.cops.push({
      id: 900 + i, mode: 'car', car: cruiser, health: 90, shootCd: 0,
      x: cruiser.x, y: cruiser.y, angle: 0, state: 'drive',
    });
  }

  state.player.wanted = 4;
  state.player.heat = 4;
  state.player.health = 72;
  state.player.armour = 45;
  state.player.money = 12450;
  // Close camera: at 1.55 the player's car is ~145px long and the cruisers behind are unmistakable.
  state.camera.x = playerCar.x + 34;
  state.camera.y = playerCar.y - 26;
  state.camera.zoom = 1.55;
  state.camera.shake = 5;

  // Traffic to weave through, placed ahead in the frame rather than only in the far distance.
  settleTraffic(state, 6);
  carAt(state, 'van', px + 210, py - 18, 'h', 1, 118);
  carAt(state, 'sedan', px + 340, py - 18, 'h', 1, 124);
  carAt(state, 'taxi', px + 250, road + 19, 'h', -1, 112);
  carAt(state, 'sedan', px + 130, road + 19, 'h', -1, 108);

  // Rubber laid down by the pursuit, plus tyre smoke and a muzzle flash from the lead cruiser.
  for (let i = 0; i < 30; i += 1) {
    addSkid(state, px - 210 + i * 8, py + (i % 2 ? 7 : -7), 0.05, 0.8);
  }
  for (let i = 0; i < 14; i += 1) {
    addParticles(state, px - 40 + i * 6, py, 2, { colour: PALETTE.neonAmber, maxSpeed: 120, maxLife: 0.3 });
  }
  addParticles(state, px - 74, py + 4, 9, { colour: '#cfe0ff', maxSpeed: 190, maxLife: 0.18, spread: 1.2, angle: 0 });

  state.missionMarker = null;
  state.objective = 'LOSE THE PURSUIT';
  state.bannerText = null;
  state.missionBannerT = 0;
  state.shotClean = false;
  state.shotTitle = false;
  state.weather.rain = 0.9;
  return 'chase';
}

/* ------------------------------------------------------------------ mission */

function stageMission(state) {
  const { city } = state;
  const market = state.places.park;

  // Put the player on the edge of the Salt Market with the crew in front of them.
  state.player.inCar = false;
  state.player.car = null;
  state.player.x = market.x - 96;
  state.player.y = market.y + 74;
  state.player.angle = -0.5;
  state.player.health = 88;
  state.player.armour = 30;
  state.player.money = 24800;
  state.player.weapon = 'smg';
  state.player.ammo.smg = 96;
  state.player.hasWeapon.smg = true;
  state.player.wanted = 2;
  state.player.heat = 2.2;
  state.player.aiming = true;

  // A mission is genuinely running: the crew job, one man already down.
  state.missionIndex = 2;
  const m = state.missions[2];
  m.started = true;
  m.step = 0;
  m.kills = 3;
  m.killsNeeded = 6;
  state.active = m;
  state.objective = "Take out Hollow's crew — 3/6";
  state.bannerText = {
    title: 'SALT & RUST',
    sub: 'Six of Hollow\'s boys are leaning on my market. Lean back.',
    colour: PALETTE.neonAmber,
    speaker: 'MAMA SABLE',
    role: 'salt market',
  };
  state.missionBannerT = 4.4;

  // Two crewmen alive and shooting, one on the ground, one behind a car.
  const alive = state.crew.slice(0, 3);
  for (let i = 0; i < alive.length; i += 1) {
    const ped = alive[i];
    const a = -0.6 + i * 0.55;
    ped.x = market.x + Math.cos(a) * 88;
    ped.y = market.y + Math.sin(a) * 74;
    ped.angle = a + Math.PI;
    ped.health = 40;
    ped.armed = true;
    ped.panicked = 0;
  }
  if (state.crew[3]) {
    const dead = state.crew[3];
    dead.dead = true;
    dead.deadTimer = 2;
  }
  if (state.crew[4]) { state.crew[4].x = -900; state.crew[4].y = -900; }
  if (state.crew[5]) { state.crew[5].x = -900; state.crew[5].y = -900; }

  // Bystanders running.
  for (let i = 0; i < 7; i += 1) {
    const a = i * 1.7;
    spawnPed(state, market.x + Math.cos(a) * 150, market.y + Math.sin(a) * 130, { block: 0 });
  }
  for (let i = 1; i < state.peds.length; i += 3) {
    state.peds[i].panicked = 3;
    state.peds[i].panicFrom = { x: market.x - 60, y: market.y + 60 };
  }

  // Bullets in flight, muzzle flash, sparks: a firefight mid-beat.
  const aim = { x: market.x + 24, y: market.y + 4 };
  const ang = Math.atan2(aim.y - state.player.y, aim.x - state.player.x);
  for (let i = 0; i < 3; i += 1) {
    const off = i * 0.05;
    state.bullets.push({
      x: state.player.x + Math.cos(ang) * (60 + i * 46),
      y: state.player.y + Math.sin(ang) * (60 + i * 46),
      px: state.player.x + Math.cos(ang) * (30 + i * 46),
      py: state.player.y + Math.sin(ang) * (30 + i * 46),
      vx: Math.cos(ang) * 900, vy: Math.sin(ang) * 900,
      life: 1.5, damage: 17, colour: '#ffe27a', friendly: true,
    });
  }
  addParticles(state, state.player.x + Math.cos(ang) * 22, state.player.y + Math.sin(ang) * 22,
    9, { angle: ang, spread: 0.8, minSpeed: 120, maxSpeed: 380, colour: '#ffe27a', maxLife: 0.24, maxSize: 3 });
  addParticles(state, market.x + 20, market.y, 8, { colour: '#ffb648', maxSpeed: 180, kind: 'smoke', maxLife: 0.9, maxSize: 5 });

  // A police car arriving at the edge, lights on.
  const cruiser = makeCar(state, 'police', market.x + 210, market.y + 96, 0, {});
  placeOnRoad(state, cruiser, 'h', -1, 0);
  cruiser.rail = false;
  cruiser.parked = true;
  cruiser.vx = 0; cruiser.vy = 0;
  cruiser.driver = { npc: true };
  state.cops.push({ id: 910, mode: 'car', car: cruiser, health: 90, shootCd: 0, x: cruiser.x, y: cruiser.y, angle: 0, state: 'drive' });

  state.camera.x = state.player.x + 62;
  state.camera.y = state.player.y - 44;
  state.camera.zoom = 1.85;
  state.camera.shake = 3;
  settleTraffic(state, 3);
  state.shotClean = false;
  state.shotTitle = false;
  state.weather.rain = 0.6;
  return 'mission';
}

/* ------------------------------------------------------------------ foot */

function stageFoot(state) {
  const { city } = state;
  // A Lantern Row corner: shop signs, a crowd, the lock-up behind.
  const block = city.blocks[city.grid * 0 + 5];
  const cxp = block.x + block.w * 0.5;
  const cyp = block.y + block.h + 34;

  state.player.inCar = false;
  state.player.car = null;
  state.player.x = cxp - 30;
  state.player.y = cyp + 22;
  state.player.angle = -1.9;
  state.player.aiming = true;
  state.player.health = 64;
  state.player.armour = 0;
  state.player.money = 3720;
  state.player.weapon = 'sidearm';
  state.player.wanted = 1;
  state.player.heat = 1.4;
  state.missionIndex = 0;
  state.objective = 'VEX — DEAD DROP';

  // The contact, waiting under their marker.
  const m = state.missions[0];
  m.x = cxp + 74;
  m.y = cyp - 40;
  state.missionMarker = { x: m.x, y: m.y, colour: m.colour, name: m.giverId, title: m.title };
  const contact = spawnPed(state, m.x, m.y, { block: 0 });
  contact.colour = PALETTE.neonMagenta;
  contact.hat = true;
  contact.angle = Math.atan2(state.player.y - m.y, state.player.x - m.x);

  // The drop is being watched. A rival crewman has stepped out of the alley with a pistol up,
  // which is what turns a handoff into a moment worth photographing.
  const rival = spawnPed(state, cxp + 132, cyp + 34, { kind: 'thug', block: 0 });
  rival.armed = true;
  rival.health = 45;
  rival.angle = Math.atan2(state.player.y - rival.y, state.player.x - rival.x);

  // The player is squared up on the rival, so the aim line and the reticle land on a threat.
  state.shotAim = { wx: rival.x, wy: rival.y - 4 };

  // Crowd on the sidewalk, some walking away.
  for (let i = 0; i < 12; i += 1) {
    const t = i * 46;
    const pt = sidewalkPoint(block, t);
    const ped = spawnPed(state, pt.x + (i % 3) * 4, pt.y + 6, { block: city.blocks.indexOf(block) });
    ped.perT = t;
    ped.dirSign = i % 2 ? 1 : -1;
    ped.colour = ['#39405a', '#4a3d52', '#2f4a4a', '#514038', '#3b3550'][i % 5];
  }
  // A parked car and a cruising taxi for depth.
  const parked = makeCar(state, 'muscle', cxp + 96, cyp + 8, Math.PI / 2, { color: '#5a2430' });
  placeOnRoad(state, parked, 'v', 1, 0);
  parked.rail = false;
  parked.parked = true;
  parked.vx = 0; parked.vy = 0;
  const taxi = carAt(state, 'taxi', cxp - 220, cyp - 8, 'h', 1, 120);

  // A few sparking pickups so the world reads as a game with things to find.
  state.pickups.push({ id: 7001, x: cxp + 44, y: cyp - 12, kind: 'cash', value: 250, bob: 0.4, taken: false });
  state.pickups.push({ id: 7002, x: cxp - 84, y: cyp + 40, kind: 'health', value: 40, bob: 1.1, taken: false });

  // A beat cop on the far corner, watching.
  const copPed = { x: cxp + 190, y: cyp - 60, angle: 2.4 };
  state.cops.push({ id: 920, mode: 'foot', car: null, health: 90, shootCd: 1, ...copPed, vx: 0, vy: 0, think: 0 });

  // Bullet holes in the air from a shot just taken — the muzzle flash is the moment.
  const aimAng = -1.9;
  state.bullets.push({
    x: cxp - 30 + Math.cos(aimAng) * 92,
    y: cyp + 22 + Math.sin(aimAng) * 92,
    px: cxp - 30 + Math.cos(aimAng) * 46,
    py: cyp + 22 + Math.sin(aimAng) * 46,
    vx: Math.cos(aimAng) * 980, vy: Math.sin(aimAng) * 980,
    life: 1.4, damage: 26, colour: PALETTE.neonCyan, friendly: true,
  });
  addParticles(state, cxp - 30 + Math.cos(aimAng) * 22, cyp + 22 + Math.sin(aimAng) * 22,
    8, { angle: aimAng, spread: 0.6, minSpeed: 100, maxSpeed: 300, colour: PALETTE.neonCyan, maxLife: 0.2 });

  // Point the player at the rival so the pose, the bullet and the aim line all agree.
  const toRival = Math.atan2(rival.y - state.player.y, rival.x - state.player.x);
  state.player.angle = toRival;

  // Centre the frame between the player and the rival, biased up so the shopfronts stay in shot.
  state.camera.x = (state.player.x + rival.x) * 0.5;
  state.camera.y = (state.player.y + rival.y) * 0.5 - 30;
  state.camera.zoom = 1.9;
  state.camera.shake = 2;
  settleTraffic(state, 4);
  state.shotClean = false;
  state.shotTitle = false;
  state.weather.rain = 0.5;
  return 'foot';
}

/**
 * Stage `name` on `state` and return the scene id. Unknown names fall back to the city shot, so a
 * mistyped query still produces a frame instead of a blank canvas.
 */
export function stageShot(name, state) {
  switch (name) {
    case 'chase': return stageChase(state);
    case 'mission': return stageMission(state);
    case 'foot': return stageFoot(state);
    case 'title': state.shotTitle = true; return stageCity(state);
    default: return stageCity(state);
  }
}
