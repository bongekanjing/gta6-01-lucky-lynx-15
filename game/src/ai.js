// Behaviour only. Traffic drives its lane (physics.stepCarRail owns the wheel), pedestrians
// wander the sidewalks and flee when anything loud happens, police chase on foot and in cars and
// shoot when the heat is high enough. No drawing, no input.
import { VEHICLES, WANTED, WEAPONS } from './config.js';
import { addParticles, addFloater, pushEvent, sidewalkPoint, spawnPolice } from './world.js';
import { clamp, angleDiff, dist, rand, TAU } from './util.js';
import { collideBuildings, clampToWorld } from './physics.js';

const SIDEWALK_SPEED = 42;

/** Walk a ped along the sidewalk loop of its block, pausing now and then. */
function stepPedNormal(state, ped, dt) {
  const block = state.city.blocks[ped.block];
  if (!block) {
    ped.dead = true;
    return;
  }
  ped.walkTimer = (ped.walkTimer ?? 0) - dt;
  if (ped.walkTimer < 0) {
    ped.walkTimer = rand(state.rng, 2, 7);
    ped.pause = state.rng() < 0.35;
  }
  if (ped.pause) {
    ped.vx *= 0.86;
    ped.vy *= 0.86;
    return;
  }
  // Pick a target about 40 units along the perimeter, then walk toward it.
  const per = 2 * ((block.w - 20) + (block.h - 20));
  ped.perT = ((ped.perT ?? rand(state.rng, 0, per)) + ped.dirSign * SIDEWALK_SPEED * dt) % per;
  const p = sidewalkPoint(block, ped.perT);
  const dx = p.x - ped.x;
  const dy = p.y - ped.y;
  const d = Math.hypot(dx, dy) || 1;
  ped.speed = SIDEWALK_SPEED;
  ped.vx = (dx / d) * SIDEWALK_SPEED;
  ped.vy = (dy / d) * SIDEWALK_SPEED;
  ped.angle = Math.atan2(dy, dx);
}

function fleeFrom(state, ped, fx, fy, dt) {
  const dx = ped.x - fx;
  const dy = ped.y - fy;
  const d = Math.hypot(dx, dy) || 1;
  const sp = 96;
  ped.vx = (dx / d) * sp;
  ped.vy = (dy / d) * sp;
  ped.angle = Math.atan2(ped.vy, ped.vx);
  ped.speed = sp;
}

/** Panic radius grows with the shot's loudness. */
export function makeNoise(state, x, y, radius, strength = 1) {
  for (let i = 0; i < state.peds.length; i += 1) {
    const p = state.peds[i];
    if (p.dead) continue;
    const d = dist(p.x, p.y, x, y);
    if (d < radius) {
      p.panicked = Math.max(p.panicked, 3 + strength * 2);
      p.panicFrom = { x, y };
    }
  }
}

/** Everything that walks: peds, civilians in cars, cops on foot. */
export function stepAi(state, dt) {
  const p = state.player;
  for (let i = 0; i < state.peds.length; i += 1) {
    const ped = state.peds[i];
    if (ped.dead) {
      ped.deadTimer += dt;
      continue;
    }
    ped.hurt = Math.max(0, ped.hurt - dt);
    if (ped.panicked > 0) {
      ped.panicked -= dt;
      const from = ped.panicFrom ?? { x: p.x, y: p.y };
      fleeFrom(state, ped, from.x, from.y, dt);
    } else {
      stepPedNormal(state, ped, dt);
    }
    ped.x += ped.vx * dt;
    ped.y += ped.vy * dt;
    collideBuildings(state, ped, 7);
    clampToWorld(state, ped, 12);
    ped.phase += dt * (2 + ped.speed * 0.06);
  }

  // Police on foot.
  for (let i = 0; i < state.cops.length; i += 1) {
    const cop = state.cops[i];
    if (cop.mode !== 'foot') continue;
    stepCopFoot(state, cop, dt);
  }
}

/** Police officer on foot: walk toward the player, shoot at range, die when shot enough. */
function stepCopFoot(state, cop, dt) {
  const p = state.player;
  cop.shootCd = Math.max(0, cop.shootCd - dt);
  cop.think -= dt;
  const d = dist(cop.x, cop.y, p.x, p.y);

  if (d > 190) {
    cop.vx = 0;
    cop.vy = 0;
    return;
  }
  const speed = 78;
  if (d > 130) {
    const dx = (p.x - cop.x) / d;
    const dy = (p.y - cop.y) / d;
    cop.vx = dx * speed;
    cop.vy = dy * speed;
    cop.angle = Math.atan2(dy, dx);
  } else {
    // Hold position, strafe a little, face the player.
    cop.vx *= 0.85;
    cop.vy *= 0.85;
    cop.angle = Math.atan2(p.y - cop.y, p.x - cop.x);
  }
  cop.x += cop.vx * dt;
  cop.y += cop.vy * dt;
  collideBuildings(state, cop, 8);
  clampToWorld(state, cop, 16);

  // Line of sight: is a building between us?
  const clear = lineClear(state, cop.x, cop.y, p.x, p.y);
  if (clear && d < 300 && cop.shootCd <= 0 && !p.dead && state.player.wanted >= 3) {
    cop.shootCd = rand(state.rng, 0.75, 1.5);
    state.events.push({
      name: 'copFire',
      data: { x: cop.x, y: cop.y, tx: p.x + rand(state.rng, -22, 22), ty: p.y + rand(state.rng, -22, 22), damage: 9 },
    });
  }
}

/** Is the straight line between two points free of buildings? Sampled; cheap enough at our scale. */
export function lineClear(state, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.hypot(dx, dy);
  const steps = Math.ceil(d / 26);
  const solids = state.city.solids;
  for (let s = 1; s < steps; s += 1) {
    const x = ax + (dx * s) / steps;
    const y = ay + (dy * s) / steps;
    for (let i = 0; i < solids.length; i += 1) {
      const b = solids[i];
      if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return false;
    }
  }
  return true;
}

/**
 * Police cars: the pursuit driver. It steers toward a point ahead of the player, biases for
 * open road, and rams. At 4+ stars a second cruiser joins.
 */
export function stepCopCars(state, dt) {
  const p = state.player;
  for (let i = 0; i < state.cops.length; i += 1) {
    const cop = state.cops[i];
    if (cop.mode !== 'car') continue;
    const car = cop.car;
    if (!car || car.wrecked) {
      // Bail out and continue on foot.
      if (car) {
        car.wrecked = true;
        car.driver = null;
      }
      cop.mode = 'foot';
      cop.x = car ? car.x : cop.x;
      cop.y = car ? car.y : cop.y;
      cop.vx = 0;
      cop.vy = 0;
      cop.think = 0;
      addParticles(state, cop.x, cop.y, 10, { colour: '#ffb648', kind: 'smoke' });
      continue;
    }
    const target = p.inCar && p.car ? p.car : p;
    const d = dist(car.x, car.y, target.x, target.y);
    cop.carTarget = { x: target.x, y: target.y };
    const desired = Math.atan2(target.y - car.y, target.x - car.x)
      + (p.inCar ? 0 : Math.sin(state.time * 1.5 + i) * 0.15);
    const diff = angleDiff(car.angle, desired);
    const throttle = d > 70 ? 1 : d > 40 ? 0.35 : -0.2;
    const steer = clamp(diff * 2.2, -1, 1);
    // Simple obstacle nudge: if a building is straight ahead, steer off it.
    const ax = car.x + Math.cos(car.angle) * 46;
    const ay = car.y + Math.sin(car.angle) * 46;
    for (let k = 0; k < state.city.solids.length; k += 1) {
      const b = state.city.solids[k];
      if (ax > b.x - 4 && ax < b.x + b.w + 4 && ay > b.y - 4 && ay < b.y + b.h + 4) {
        cop.stuck = (cop.stuck ?? 0) + dt;
        break;
      }
    }
    if (cop.stuck > 0.6) {
      cop.car.vx *= -0.2;
      cop.car.vy *= -0.2;
      cop.stuck = 0;
    }
    stepCopCar(state, car, throttle, steer, dt);
    car.sirenPhase += dt * 6;
    // When close and the player is on foot, bail out.
    if (!p.inCar && d < 130 && Math.hypot(car.vx, car.vy) < 55 && !cop.bailed) {
      cop.bailed = true;
      cop.mode = 'foot';
      cop.x = car.x + Math.cos(car.angle + Math.PI / 2) * 20;
      cop.y = car.y + Math.sin(car.angle + Math.PI / 2) * 20;
      car.driver = null;
      car.brake = true;
      addParticles(state, cop.x, cop.y, 6, { colour: '#9fb6ff' });
    }
  }
}

/** A police car handles like the player's but grips a little harder and never drifts. */
function stepCopCar(state, car, throttle, steer, dt) {
  const spec = VEHICLES[car.type];
  const fwdX = Math.cos(car.angle);
  const fwdY = Math.sin(car.angle);
  const fwd = car.vx * fwdX + car.vy * fwdY;
  const limit = spec.maxSpeed;
  if (throttle > 0 && fwd < limit) {
    const a = spec.accel * throttle * (1 - Math.max(0, fwd) / (limit * 1.04));
    car.vx += fwdX * a * dt;
    car.vy += fwdY * a * dt;
  } else if (throttle < 0) {
    car.vx += fwdX * spec.brake * throttle * dt * 0.7;
    car.vy += fwdY * spec.brake * throttle * dt * 0.7;
  } else {
    car.vx -= car.vx * 0.5 * dt;
    car.vy -= car.vy * 0.5 * dt;
  }
  const latX = -fwdY;
  const latY = fwdX;
  const lat = car.vx * latX + car.vy * latY;
  car.vx -= latX * lat * clamp(8 * dt, 0, 1);
  car.vy -= latY * lat * clamp(8 * dt, 0, 1);
  const speed = Math.hypot(car.vx, car.vy);
  const authority = clamp(speed / 60, 0, 1);
  car.angle += spec.turn * authority * steer * dt * (fwd < -6 ? -1 : 1);
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.speed = Math.hypot(car.vx, car.vy);
  car.wheel += car.speed * dt * 0.4;
  collideBuildings(state, car, car.spec.wid * 0.5);
  const w = state.city.water;
  if (car.x > w.x - 30) car.x = w.x - 30;
  if (car.x < 30) car.x = 30;
  if (car.y < 30) car.y = 30;
  if (car.y > state.city.size - 30) car.y = state.city.size - 30;
}

/**
 * Wanted level bookkeeping. Shooting a civilian is a small crime, a cop a big one; when the
 * player has not been seen by a cop or a witness for `coolDelay` seconds the stars drain.
 */
export function stepWanted(state, dt) {
  const p = state.player;
  const copSees = anyCopSees(state);
  if (copSees) p.seenTimer = 0;
  else p.seenTimer += dt;

  if (p.wanted > 0 && p.seenTimer > WANTED.coolDelay) {
    p.heat = Math.max(0, p.heat - WANTED.coolPerSecond * dt);
  }
  const starsByHeat = Math.floor(p.heat);
  if (starsByHeat < p.wanted) {
    p.wanted = Math.max(0, p.wanted - 1);
    p.heat = Math.max(0, Math.floor(p.heat));
    if (p.wanted === 0) {
      state.events.push({ name: 'lostCops' });
      p.heat = 0;
    }
  }

  // Spawn pursuit to match the stars.
  const wantCars = p.wanted >= 4 ? 3 : p.wanted >= 2 ? 2 : p.wanted >= 1 ? 1 : 0;
  const activeCars = state.cops.filter((c) => c.mode === 'car').length;
  state.spawnTimer = (state.spawnTimer ?? 0) - dt;
  if (activeCars < wantCars && state.spawnTimer <= 0) {
    state.spawnTimer = 2.6;
    spawnPolice(state);
    const cop = state.cops[state.cops.length - 1];
    if (cop && cop.car) cop.car.railSpeed = 200;
  }
  // Prune cops that are far away and no longer needed.
  if (state.cops.length > wantCars * 2 + 2) {
    for (let i = state.cops.length - 1; i >= 0 && state.cops.length > wantCars + 1; i -= 1) {
      const cop = state.cops[i];
      const d = cop.car ? dist(cop.car.x, cop.car.y, p.x, p.y) : dist(cop.x, cop.y, p.x, p.y);
      if (d > 1700) state.cops.splice(i, 1);
    }
  }
  if (p.wanted === 0 && state.cops.length > 0) {
    for (let i = state.cops.length - 1; i >= 0; i -= 1) {
      const cop = state.cops[i];
      const cx = cop.car ? cop.car.x : cop.x;
      const cy = cop.car ? cop.car.y : cop.y;
      if (dist(cx, cy, p.x, p.y) > 900) state.cops.splice(i, 1);
    }
  }
}

/** Late import to avoid a cycle: world.js imports ai? It does not, so this is safe but plain. */
let spawnCopImpl = null;
export function bindSpawnCop(fn) {
  spawnCopImpl = fn;
}
function spawnCop(state) {
  if (spawnCopImpl) spawnCopImpl(state);
}

export function anyCopSees(state) {
  const p = state.player;
  for (let i = 0; i < state.cops.length; i += 1) {
    const cop = state.cops[i];
    const cx = cop.car ? cop.car.x : cop.x;
    const cy = cop.car ? cop.car.y : cop.y;
    const d = dist(cx, cy, p.x, p.y);
    if (d < 520 && lineClear(state, cx, cy, p.x, p.y)) return true;
  }
  // Civilians report you too, at a shorter range.
  if (p.wanted >= 2) {
    for (let i = 0; i < state.peds.length; i += 1) {
      const ped = state.peds[i];
      if (ped.dead) continue;
      if (dist(ped.x, ped.y, p.x, p.y) < 170) return true;
    }
  }
  return false;
}

/** Register a crime and raise the wanted level. */
export function commitCrime(state, amount) {
  const p = state.player;
  p.heat = Math.min(WANTED.max + 0.99, p.heat + amount);
  state.lastCrimeAt = state.time;
  p.seenTimer = 0;
  const target = Math.min(WANTED.max, Math.floor(p.heat));
  if (target > p.wanted) {
    p.wanted = target;
    state.events.push({ name: 'wantedUp', data: { level: p.wanted } });
  }
}
