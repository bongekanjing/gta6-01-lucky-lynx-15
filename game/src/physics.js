// Movement and collision. Walkers are circles, cars are oriented capsules approximated by three
// circles along their length — cheap, stable, and good enough that a car cannot shove itself
// through a building wall. Nothing here draws or reads input; main.js and ai.js call in.
import { FOOT, VEHICLES } from './config.js';
import { addSkid, laneOffset } from './world.js';
import { clamp, resolveCircleRect, dist2, angleDiff, TAU } from './util.js';

const CAR_CIRCLES = [-0.3, 0, 0.32];

/** Push a circle out of every nearby building. Returns the summed normal, for wall sliding. */
export function collideBuildings(state, ent, radius, ax = 'all') {
  let nx = 0;
  let ny = 0;
  const solids = state.city.solids;
  for (let i = 0; i < solids.length; i += 1) {
    const s = solids[i];
    if (ent.x + radius < s.x || ent.x - radius > s.x + s.w) continue;
    if (ent.y + radius < s.y || ent.y - radius > s.y + s.h) continue;
    const hit = resolveCircleRect(ent.x, ent.y, radius, s.x, s.y, s.w, s.h);
    if (!hit) continue;
    ent.x = hit.x;
    ent.y = hit.y;
    nx += hit.nx;
    ny += hit.ny;
  }
  if (ax === 'all') return { nx, ny };
  return { nx, ny };
}

/** Keep a walker inside the map and out of the water. */
export function clampToWorld(state, ent, pad = 20) {
  const max = state.city.size - pad;
  if (ent.x < pad) { ent.x = pad; ent.vx = Math.abs(ent.vx || 0); }
  if (ent.y < pad) { ent.y = pad; ent.vy = Math.abs(ent.vy || 0); }
  if (ent.x > max) { ent.x = max; ent.vx = -Math.abs(ent.vx || 0); }
  if (ent.y > max) { ent.y = max; ent.vy = -Math.abs(ent.vy || 0); }
  // The waterfront is solid.
  const w = state.city.water;
  if (ent.x > w.x - pad * 0.5) {
    ent.x = w.x - pad * 0.5;
    ent.vx = -Math.abs(ent.vx || 0);
  }
}

const footDamp = (dt, k) => 1 - Math.exp(-k * dt);

/**
 * Move the player on foot. `input` is {mx,my} in world axes, `dt` seconds. Walls are resolved per
 * axis so you slide along a facade instead of sticking to it.
 */
export function stepFootPlayer(state, input, dt, sprint) {
  const p = state.player;
  const speed = sprint ? FOOT.sprint : FOOT.walk;
  const targetX = input.mx * speed;
  const targetY = input.my * speed;
  // Sprinting drains nothing but audibly changes the walk cycle; accelerate toward the target.
  p.vx += (targetX - p.vx) * footDamp(dt, input.mx || input.my ? 14 : 9);
  p.vy += (targetY - p.vy) * footDamp(dt, input.mx || input.my ? 14 : 9);

  const ox = p.x;
  const oy = p.y;
  p.x += p.vx * dt;
  collideBuildings(state, p, FOOT.radius);
  clampToWorld(state, p, 14);
  p.y += p.vy * dt;
  collideBuildings(state, p, FOOT.radius);
  clampToWorld(state, p, 14);

  const moved = Math.hypot(p.x - ox, p.y - oy);
  state.stats.distance += moved;
  p.walkPhase += moved * 0.09;
  if (moved > 0.4) {
    const want = Math.atan2(p.vy, p.vx);
    p.angle += angleDiff(p.angle, want) * footDamp(dt, 16);
  }
  p.sprint = sprint && moved > 1;
  p.speed = moved / Math.max(dt, 1e-5);
}

/** The world-space point a car's circle sits at. */
export function carPoint(car, t, out) {
  out.x = car.x + Math.cos(car.angle) * car.spec.len * t;
  out.y = car.y + Math.sin(car.angle) * car.spec.len * t;
  return out;
}

/** Car vs buildings: resolve each of the three circles, then bleed speed on a solid hit. */
export function collideCarBuildings(state, car) {
  const r = car.spec.wid / 2;
  let bump = 0;
  for (let i = 0; i < CAR_CIRCLES.length; i += 1) {
    const t = CAR_CIRCLES[i];
    const cx = car.x + Math.cos(car.angle) * car.spec.len * t;
    const cy = car.y + Math.sin(car.angle) * car.spec.len * t;
    const probe = { x: cx, y: cy };
    collideBuildings(state, probe, r);
    const dx = probe.x - cx;
    const dy = probe.y - cy;
    if (dx || dy) {
      car.x += dx;
      car.y += dy;
      bump += Math.hypot(dx, dy);
      // Kill the velocity along the wall normal.
      const n = Math.hypot(dx, dy) || 1;
      const dot = car.vx * (dx / n) + car.vy * (dy / n);
      if (dot < 0) {
        car.vx -= (dx / n) * dot;
        car.vy -= (dy / n) * dot;
      }
    }
  }
  const w = state.city.water;
  if (car.x > w.x - 30) {
    car.x = w.x - 30;
    car.vx = Math.min(0, car.vx);
  }
  const pad = 30;
  if (car.x < pad) { car.x = pad; car.vx = Math.abs(car.vx) * 0.2; }
  if (car.y < pad) { car.y = pad; car.vy = Math.abs(car.vy) * 0.2; }
  if (car.y > state.city.size - pad) { car.y = state.city.size - pad; car.vy = -Math.abs(car.vy) * 0.2; }
  if (bump > 2.2) {
    // A real impact: shake it, spark it, and damage the car in proportion to speed.
    const sp = Math.hypot(car.vx, car.vy);
    if (sp > 120) {
      car.health -= sp * 0.045;
      state.camera.shake = Math.min(18, state.camera.shake + sp * 0.035);
      state.lastImpact = { x: car.x, y: car.y, power: sp };
    }
    car.vx *= 0.55;
    car.vy *= 0.55;
  }
  return bump;
}

/**
 * Arcade car handling. `throttle` -1..1, `steer` -1..1 (left positive), `handbrake` bool.
 * Steering scales with speed up to a point and is weaker when very fast, which is what makes
 * the sports car feel twitchy and the van feel heavy.
 */
export function stepCarPlayer(state, car, throttle, steer, handbrake, dt) {
  const spec = car.spec;
  const speed = Math.hypot(car.vx, car.vy);
  const fwdX = Math.cos(car.angle);
  const fwdY = Math.sin(car.angle);
  // Forward component only: a car does not accelerate sideways.
  const fwd = car.vx * fwdX + car.vy * fwdY;

  if (throttle > 0) {
    const limit = spec.maxSpeed * (car.health < spec.health * 0.4 ? 0.62 : 1);
    if (fwd < limit) {
      const a = spec.accel * throttle * (1 - Math.max(0, fwd) / (limit * 1.06));
      car.vx += fwdX * a * dt;
      car.vy += fwdY * a * dt;
    }
  } else if (throttle < 0) {
    // Reverse is slow, and it brakes first when rolling forward.
    if (fwd > 12) {
      car.vx -= fwdX * spec.brake * dt * -throttle;
      car.vy -= fwdY * spec.brake * dt * -throttle;
    } else if (fwd > -spec.maxSpeed * 0.35) {
      car.vx += fwdX * spec.accel * 0.6 * throttle * dt;
      car.vy += fwdY * spec.accel * 0.6 * throttle * dt;
    }
  } else {
    // Engine braking.
    car.vx -= car.vx * 0.55 * dt;
    car.vy -= car.vy * 0.55 * dt;
  }

  // Lateral grip: remove some sideways velocity (less when handbraking, for the drift).
  const latX = -fwdY;
  const latY = fwdX;
  const lat = car.vx * latX + car.vy * latY;
  const grip = handbrake ? 1.6 : 7.5 - Math.min(4.2, speed / 130);
  const lost = lat * clamp(grip * dt, 0, 1);
  car.vx -= latX * lost;
  car.vy -= latY * lost;

  // Steering: authority peaks in the middle of the speed range.
  const authority = clamp(speed / 70, 0, 1) * (1 - clamp((speed - 190) / 420, 0, 0.55));
  const dirSign = fwd < -6 ? -1 : 1;
  const turn = spec.turn * authority * steer * dirSign * dt;
  car.angle += turn;
  car.steer = steer;
  car.wheel += (handbrake ? 14 : turn * 22);

  // Rolling resistance and drag.
  const drag = handbrake ? 1.5 : 0.32;
  const k = Math.exp(-drag * dt);
  car.vx *= k;
  car.vy *= k;

  car.x += car.vx * dt;
  car.y += car.vy * dt;
  collideCarBuildings(state, car);

  car.speed = Math.hypot(car.vx, car.vy);
  car.engine = clamp(Math.abs(throttle) * 0.6 + car.speed / spec.maxSpeed * 0.6, 0, 1);

  // Tyre marks when the car is sideways or braking hard.
  const slip = Math.abs(lat);
  if ((slip > 42 || (handbrake && speed > 40)) && state.skids.length < 800) {
    const back = 0.32;
    const bx = car.x - fwdX * spec.len * back;
    const by = car.y - fwdY * spec.len * back;
    addSkid(state, bx + latX * spec.wid * 0.32, by + latY * spec.wid * 0.32, car.angle, clamp(slip / 140, 0.2, 1));
    addSkid(state, bx - latX * spec.wid * 0.32, by - latY * spec.wid * 0.32, car.angle, clamp(slip / 140, 0.2, 1));
  }
}

/**
 * Car vs car: two circles each, resolved symmetrically by mass. A hard shunt spins both a little,
 * which is where most of the comedy of arcade driving comes from.
 */
export function collideCars(state) {
  const cars = state.cars;
  for (let i = 0; i < cars.length; i += 1) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j += 1) {
      const b = cars[j];
      if (Math.abs(a.x - b.x) > 90 || Math.abs(a.y - b.y) > 90) continue;
      const ra = a.spec.wid * 0.52;
      const rb = b.spec.wid * 0.52;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const min = ra + rb + a.spec.len * 0.16 + b.spec.len * 0.16;
      if (d > min || d < 0.0001) continue;
      const nx = (b.x - a.x) / d;
      const ny = (b.y - a.y) / d;
      const push = (min - d) * 0.5;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const rel = rvx * nx + rvy * ny;
      if (rel > 0) continue;
      const ma = a.spec.mass;
      const mb = b.spec.mass;
      const imp = (-rel * 1.3) / (1 / ma + 1 / mb);
      a.vx -= (nx * imp) / ma;
      a.vy -= (ny * imp) / ma;
      b.vx += (nx * imp) / mb;
      b.vy += (ny * imp) / mb;
      const hard = -rel;
      if (hard > 130) {
        a.health -= hard * 0.03;
        b.health -= hard * 0.03;
        a.angle += (nx * 0.02 * hard) / 900;
        b.angle -= (nx * 0.02 * hard) / 900;
        if (state.player.inCar && (state.player.car === a || state.player.car === b)) {
          state.camera.shake = Math.min(16, state.camera.shake + hard * 0.04);
        }
      }
    }
  }
}

/** Traffic rail behaviour: drive a street grid, stop for the car ahead, turn at intersections. */
export function stepCarRail(state, car, dt, speedScale = 1) {
  const spec = car.spec;
  const target = car.railSpeed * speedScale;
  // Find the car ahead in this lane.
  let gap = 999;
  for (let i = 0; i < state.cars.length; i += 1) {
    const o = state.cars[i];
    if (o === car) continue;
    if (o.axis !== car.axis || o.dir !== car.dir) continue;
    const along = car.axis === 'h' ? o.x - car.x : o.y - car.y;
    const ahead = along * car.dir;
    const cross = car.axis === 'h' ? Math.abs(o.y - car.y) : Math.abs(o.x - car.x);
    if (ahead > 0 && ahead < 120 && cross < 34) gap = Math.min(gap, ahead);
  }
  // Pedestrians in the road also stop traffic.
  const p = state.player;
  if (!p.inCar) {
    const along = car.axis === 'h' ? p.x - car.x : p.y - car.y;
    const ahead = along * car.dir;
    const cross = car.axis === 'h' ? Math.abs(p.y - car.y) : Math.abs(p.x - car.x);
    if (ahead > 0 && ahead < 62 && cross < 26) gap = Math.min(gap, ahead);
  }

  const want = gap < 58 ? 0 : gap < 100 ? target * 0.5 : target;
  car.vx += (Math.cos(car.angle) * want - car.vx) * (1 - Math.exp(-3.4 * dt));
  car.vy += (Math.sin(car.angle) * want - car.vy) * (1 - Math.exp(-3.4 * dt));
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // Turning: at every cell line the car may take the crossing street. The choice is derived from
  // the car's id and the node it is passing, so it is stable and repeatable.
  const cell = state.city.cell;
  const coord = car.axis === 'h' ? car.x : car.y;
  const node = Math.round(coord / cell) * cell;
  const nodeKey = Math.round(node / cell);
  if (nodeKey !== car.lastNode && Math.abs(coord - node) < cell * 0.16) {
    car.lastNode = nodeKey;
    const roll = ((car.id * 37 + nodeKey * 61 + 7) % 100) / 100;
    if (roll < 0.3 && node > 0 && node < state.city.size) {
      const newAxis = car.axis === 'h' ? 'v' : 'h';
      const newDir = (car.id + nodeKey) % 2 === 0 ? 1 : -1;
      car.axis = newAxis;
      car.dir = newDir;
      if (newAxis === 'h') {
        car.y = node + laneOffset('h', newDir);
        car.x = node;
      } else {
        car.x = node + laneOffset('v', newDir);
        car.y = node;
      }
    }
  }
  const wantAngle = car.axis === 'h' ? (car.dir > 0 ? 0 : Math.PI) : (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  car.angle += angleDiff(car.angle, wantAngle) * (1 - Math.exp(-6 * dt));
  car.speed = Math.hypot(car.vx, car.vy);
  car.wheel += car.speed * dt * 0.5;
  car.brake = want < car.railSpeed * 0.6;
  collideCarBuildings(state, car);
}

/** Push a ped out of the player and out of car bodies so nobody stands inside anybody. */
export function separateWalkers(state) {
  const p = state.player;
  const list = state.peds;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.dead) continue;
    if (!p.inCar && !p.dead) {
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 18 && d > 0.001) {
        a.x += (dx / d) * (18 - d) * 0.5;
        a.y += (dy / d) * (18 - d) * 0.5;
      }
    }
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (b.dead) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 14 * 14 && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const push = (14 - d) * 0.5;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
  }
}

/** Vehicles sweep the street: a ped or the player caught under a moving car takes a hit. */
export function runOverCheck(state) {
  for (let i = 0; i < state.cars.length; i += 1) {
    const car = state.cars[i];
    const speed = Math.hypot(car.vx, car.vy);
    if (speed < 40) continue;
    const fwdX = Math.cos(car.angle);
    const fwdY = Math.sin(car.angle);
    const halfL = car.spec.len * 0.5;
    const halfW = car.spec.wid * 0.5 + 4;
    const hitOne = (ent, isPlayer) => {
      const dx = ent.x - car.x;
      const dy = ent.y - car.y;
      const along = dx * fwdX + dy * fwdY;
      const across = -dx * fwdY + dy * fwdX;
      if (Math.abs(along) > halfL + (isPlayer ? 6 : 4) || Math.abs(across) > halfW) return false;
      if (ent.hitByCar > state.time - 0.45) return false;
      ent.hitByCar = state.time;
      const dmg = speed * (isPlayer ? 0.115 : 0.2);
      return { dmg, dx: fwdX * speed * 0.5, dy: fwdY * speed * 0.5 };
    };
    const p = state.player;
    if (!p.inCar && !p.dead) {
      const h = hitOne(p, true);
      if (h) {
        state.events.push({ name: 'playerHit', data: { damage: h.dmg, x: p.x, y: p.y } });
        p.vx += h.dx; p.vy += h.dy;
      }
    }
    for (let k = 0; k < state.peds.length; k += 1) {
      const ped = state.peds[k];
      if (ped.dead) continue;
      const h = hitOne(ped, false);
      if (h) {
        ped.health -= h.dmg;
        ped.panicked = 4;
        ped.vx += h.dx;
        ped.vy += h.dy;
        if (ped.health <= 0) state.events.push({ name: 'pedDown', data: { ped, byPlayer: car.driver === 'player' } });
      }
    }
  }
}
