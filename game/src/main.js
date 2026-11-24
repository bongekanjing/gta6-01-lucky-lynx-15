// Boot, input and the one loop. This is the only module that knows about screens: title, play,
// paused, dead. It reads the keyboard and mouse every frame, hands the world to the systems in
// order (missions, player, AI, physics, wanted), consumes the events those systems queued, and
// paints. Save/load through localStorage lives here too, because it is the one place that knows
// what a "session" is.
import {
  CAMERA, DEATH_PENALTY, FOOT, PALETTE, SAVE_KEY, STEP, VIEW, WANTED, WEAPONS,
} from './config.js';
import {
  LANE, addFloater, addParticles, addSkid, carInReach, createWorld, laneOffset, makeCar,
  placeOnRoad, pushEvent, setRail, spawnPolice, updateCamera,
} from './world.js';
import { generateCity, buildSolidIndex } from './city.js';
import { createRenderer, SCREEN_PLAY, SCREEN_TITLE } from './render.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import {
  bindSpawnCop, commitCrime, lineClear, makeNoise, stepAi, stepCopCars, stepWanted,
} from './ai.js';
import {
  collideCarBuildings, collideCars, runOverCheck, separateWalkers, stepCarPlayer, stepCarRail,
  stepFootPlayer,
} from './physics.js';
import {
  currentObjective, missionMarker, nextMission, onMissionKill, setupMissions, stepMissions,
  tryStartMission,
} from './missions.js';
import { clamp, dampAngle, dist, money, TAU } from './util.js';

const SEED = 1;

/* ------------------------------------------------------------------ input */

function createInput(canvas) {
  const held = new Set();
  const pressed = new Set();
  let mx = VIEW.width / 2;
  let my = VIEW.height / 2;
  let mdown = false;
  let mdownEdge = false;
  const listeners = [];

  function toLogical(event, rect, view) {
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    return {
      x: (x - view.x) / view.scale,
      y: (y - view.y) / view.scale,
    };
  }

  const onKeyDown = (e) => {
    if (!held.has(e.code)) pressed.add(e.code);
    held.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'KeyF', 'KeyE'].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e) => held.delete(e.code);
  const onPointerMove = (e) => {
    const p = toLogical(e, canvas.getBoundingClientRect(), window.__view ?? { x: 0, y: 0, scale: 1 });
    mx = p.x; my = p.y;
  };
  const onPointerDown = (e) => {
    if (e.button === 0) { mdown = true; mdownEdge = true; }
    onPointerMove(e);
  };
  const onPointerUp = (e) => { if (e.button === 0) mdown = false; };
  const onBlur = () => { held.clear(); mdown = false; };
  const onContext = (e) => e.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('contextmenu', onContext);

  return {
    held,
    pressed,
    get mouse() { return { x: mx, y: my, down: mdown, edge: mdownEdge }; },
    down(...codes) { return codes.some((c) => held.has(c)); },
    hit(...codes) { return codes.some((c) => pressed.has(c)); },
    endFrame() { pressed.clear(); mdownEdge = false; },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      for (const l of listeners) l();
    },
  };
}

/* ------------------------------------------------------------------ save */

function readSave() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.version) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSave(save) {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ session */

export function startSession() {
  const params = new URLSearchParams(window.location.search);
  const shotName = params.get('shot');
  const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
  const seed = Number.isInteger(seedParam) ? seedParam : SEED;

  const canvas = document.getElementById('game');
  const status = document.getElementById('status');
  const city = generateCity(seed);
  buildSolidIndex(city);
  const world = createWorld(city);
  const renderer = createRenderer(canvas);
  const hud = createHud(renderer);
  const audio = createAudio();
  const state = world.state;
  window.__view = renderer.view;
  // Debug handle: lets a headless harness (and the console) read the whole session. Read-only in
  // spirit — nothing in the game reads it back.
  window.__state = state;
  window.__renderer = renderer;
  window.__debug = {
    get screen() { return screen; },
    get save() { return save; },
    get frame() { return state.frame; },
  };

  state.missions = [];
  state.missionIndex = 0;
  state.active = null;
  state.drawList = [];

  let screen = SCREEN_TITLE;
  let save = readSave();
  let accumulator = 0;
  let last = performance.now();
  let saveFlash = 0;
  const input = shotName ? createInput(canvas) : createInput(canvas);

  function announce(message) {
    if (status) status.textContent = message;
  }

  bindSpawnCop(spawnPolice);

  /* ---------------------------------------------------------------- session setup */

  function freshWorld(opts = {}) {
    world.reset(false);
    setupMissions(state);
    state.savedWeapon = null;
    state.missionMarker = missionMarker(state);
    state.objective = currentObjective(state);
    state.audio = audio;
    state.clock = 0;
    if (opts.player) {
      const p = state.player;
      p.money = opts.player.money ?? p.money;
      p.health = opts.player.health ?? p.health;
      p.armour = opts.player.armour ?? 0;
      if (opts.player.pos) { p.x = opts.player.pos.x; p.y = opts.player.pos.y; }
      if (opts.player.ammo) Object.assign(p.ammo, opts.player.ammo);
      if (opts.player.hasWeapon) Object.assign(p.hasWeapon, opts.player.hasWeapon);
      if (opts.player.weapon) p.weapon = opts.player.weapon;
    }
    if (opts.missionIndex) {
      state.missionIndex = clamp(opts.missionIndex, 0, state.missions.length);
      for (let i = 0; i < state.missionIndex; i += 1) state.missions[i].complete = true;
      state.objective = currentObjective(state);
      state.missionMarker = missionMarker(state);
    }
    state.camera.x = state.player.x;
    state.camera.y = state.player.y;
  }

  /* ---------------------------------------------------------------- weapons & combat */

  function weaponDef() {
    return WEAPONS[state.player.weapon] ?? WEAPONS.sidearm;
  }

  function aimPoint() {
    const m = input.mouse;
    return renderer.toWorld(m.x, m.y, state.camera);
  }

  function firePlayer() {
    const p = state.player;
    if (p.dead || p.inCar) return;
    const w = weaponDef();
    if (p.fireCd > 0) return;
    if (p.ammo[p.weapon] <= 0 && p.weapon !== 'sidearm') { audio.play('door'); p.fireCd = 0.4; return; }
    p.fireCd = w.rate;
    if (p.weapon !== 'sidearm') p.ammo[p.weapon] -= 1;

    const aim = aimPoint();
    const base = Math.atan2(aim.y - p.y, aim.x - p.x);
    p.angle = base;
    const count = w.pellets ?? 1;
    for (let i = 0; i < count; i += 1) {
      const a = base + (state.rng() - 0.5) * w.spread * (count > 1 ? 2 : 1);
      const speed = w.speed;
      state.bullets.push({
        x: p.x + Math.cos(base) * 16,
        y: p.y + Math.sin(base) * 16,
        px: p.x, py: p.y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: 1.6, damage: w.damage, colour: w.tracer, friendly: true,
      });
    }
    state.camera.shake = Math.min(CAMERA.maxShake, state.camera.shake + w.kick);
    p.recoil = 1;
    audio.play(w.sound);
    addParticles(state, p.x + Math.cos(base) * 20, p.y + Math.sin(base) * 20, 5, {
      angle: base, spread: 0.7, minSpeed: 90, maxSpeed: 320, colour: w.tracer, minLife: 0.08, maxLife: 0.2, maxSize: 2.4,
    });
    makeNoise(state, p.x, p.y, 460, 1);
    // Shooting in public is a crime: nearby civilians panic, and the cops come.
    if (state.player.wanted === 0) commitCrime(state, 0.42);
    else p.seenTimer = 0;
    p.aiming = true;
  }

  function meleeAttack() {
    const p = state.player;
    if (p.meleeCd > 0 || p.dead || p.inCar) return;
    p.meleeCd = FOOT.meleeCooldown;
    const reach = FOOT.meleeRange;
    let hitAny = false;
    for (let i = 0; i < state.peds.length; i += 1) {
      const ped = state.peds[i];
      if (ped.dead) continue;
      const d = dist(p.x, p.y, ped.x, ped.y);
      if (d > reach) continue;
      const a = Math.atan2(ped.y - p.y, ped.x - p.x);
      if (Math.abs(((a - p.angle + Math.PI * 3) % TAU) - Math.PI) > 1.1) continue;
      ped.health -= FOOT.meleeDamage;
      ped.panicked = 4;
      ped.panicFrom = { x: p.x, y: p.y };
      ped.hurt = 3;
      ped.vx += Math.cos(a) * 120;
      ped.vy += Math.sin(a) * 120;
      hitAny = true;
      addParticles(state, ped.x, ped.y, 6, { colour: PALETTE.neonRed, maxSpeed: 130 });
      if (ped.health <= 0) killPed(ped, true);
    }
    if (hitAny) {
      audio.play('hit');
      state.camera.shake = Math.min(CAMERA.maxShake, state.camera.shake + 3);
    }
  }

  function killPed(ped, byPlayer) {
    if (ped.dead) return;
    ped.dead = true;
    ped.deadTimer = 0;
    ped.health = 0;
    addParticles(state, ped.x, ped.y, 12, { colour: PALETTE.blood, maxSpeed: 150 });
    if (byPlayer) {
      state.stats.kills += 1;
      if (ped.crew === 'hollow' || ped.escort || ped.boss) commitCrime(state, WANTED.killCivilian * 0.6);
      else commitCrime(state, WANTED.killCivilian);
      onMissionKill(state, ped);
      audio.play('hit');
    }
    // A tiny chance of a cash drop, so a rampage pays a little.
    if (byPlayer && state.rng() < 0.3 && !ped.crew) {
      state.pickups.push({ id: 5000 + state.frame, x: ped.x, y: ped.y, kind: 'cash', value: 40 + Math.floor(state.rng() * 120), bob: 0, taken: false });
    }
  }

  /* ---------------------------------------------------------------- vehicles */

  function enterExitVehicle() {
    const p = state.player;
    if (p.dead) return;
    if (p.inCar && p.car) {
      const car = p.car;
      // Step out on the driver's side and give the car a nudge so it does not sit on us.
      p.x = car.x + Math.cos(car.angle + Math.PI / 2) * (car.spec.wid * 0.7 + 10);
      p.y = car.y + Math.sin(car.angle + Math.PI / 2) * (car.spec.wid * 0.7 + 10);
      p.inCar = false;
      p.car.driver = null;
      p.car.brake = false;
      p.car.vx *= 0.3; p.car.vy *= 0.3;
      p.car = null;
      p.vx = 0; p.vy = 0;
      audio.play('door');
      return;
    }
    const car = carInReach(state);
    if (!car) {
      state.toast = { text: 'NO VEHICLE IN REACH', colour: 'rgba(255,210,220,0.85)', life: 1.6 };
      return;
    }
    // Steal it: the driver is ejected and flees.
    if (car.driver && car.driver !== 'player') {
      if (!car.police) {
        car.driver = null;
        const ped = { x: car.x + Math.cos(car.angle + Math.PI / 2) * 22, y: car.y + Math.sin(car.angle + Math.PI / 2) * 22 };
        state.peds.push({
          id: 6000 + state.frame, x: ped.x, y: ped.y, vx: 0, vy: 0, angle: car.angle,
          health: 30, panicked: 4, panicFrom: { x: ped.x, y: ped.y }, dead: false, deadTimer: 0,
          colour: '#3a3550', skin: '#c99a76', phase: 0, hurt: 0,
        });
        commitCrime(state, WANTED.stealCar);
        state.stats.carsStolen += 1;
        state.toast = { text: 'VEHICLE STOLEN', colour: PALETTE.neonAmber, life: 2 };
        audio.play('wanted');
      } else {
        car.driver = null;
        commitCrime(state, 0.8);
        state.toast = { text: 'POLICE CRUISER TAKEN', colour: PALETTE.policeBlue, life: 2 };
        audio.play('wanted');
      }
    }
    car.driver = 'player';
    car.stolen = !car.police;
    car.rail = false;
    car.parked = false;
    p.inCar = true;
    p.car = car;
    p.dead = false;
    // Clear the mission mark on the Coda the moment it is taken.
    if (state.active && state.active.def.id === 'repossess') state.active.step = 0;
    audio.play('door');
  }

  function driveStep(dt) {
    const p = state.player;
    const car = p.car;
    if (!car) { p.inCar = false; return; }
    const up = input.down('KeyW', 'ArrowUp');
    const down = input.down('KeyS', 'ArrowDown');
    const left = input.down('KeyA', 'ArrowLeft');
    const right = input.down('KeyD', 'ArrowRight');
    const throttle = (up ? 1 : 0) - (down ? 1 : 0);
    const steer = (left ? 1 : 0) - (right ? 1 : 0);
    const hand = input.down('Space', 'ShiftLeft');
    stepCarPlayer(state, car, throttle, steer, hand, dt);
    if (car.health <= 0 && !car.wrecked) {
      car.wrecked = true;
      addParticles(state, car.x, car.y, 26, { colour: '#ffb648', maxSpeed: 260, kind: 'smoke', maxLife: 1.4, maxSize: 7 });
      state.camera.shake = 16;
      audio.play('carHit');
      // Bail out of a wreck.
      p.inCar = false;
      p.car = null;
      p.x = car.x + 18;
      p.y = car.y + 12;
      p.vx = 0; p.vy = 0;
    }
  }

  /* ---------------------------------------------------------------- events */

  function handleEvents() {
    const events = state.events;
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      switch (ev.name) {
        case 'playerHit':
          damagePlayer(ev.data.damage);
          break;
        case 'pedDown':
          killPed(ev.data.ped, ev.data.byPlayer);
          break;
        case 'wantedUp':
          audio.play('wanted');
          state.camera.shake = Math.max(state.camera.shake, 5);
          break;
        case 'lostCops':
          state.toast = { text: 'YOU LOST THE COPS', colour: PALETTE.money, life: 2.4 };
          break;
        case 'missionComplete':
          audio.play('mission');
          state.camera.shake = 4;
          break;
        case 'missionFailed':
          audio.play('fail');
          break;
        case 'copFire':
          if (lineClear(state, ev.data.x, ev.data.y, ev.data.tx, ev.data.ty)) {
            const a = Math.atan2(ev.data.ty - ev.data.y, ev.data.tx - ev.data.x);
            state.bullets.push({
              x: ev.data.x, y: ev.data.y, px: ev.data.x, py: ev.data.y,
              vx: Math.cos(a) * 820, vy: Math.sin(a) * 820,
              life: 1.6, damage: ev.data.damage, colour: '#9fb6ff', friendly: false,
            });
          }
          audio.play('pistol');
          addParticles(state, ev.data.x, ev.data.y, 3, {
            angle: Math.atan2(ev.data.ty - ev.data.y, ev.data.tx - ev.data.x),
            spread: 0.5, minSpeed: 60, maxSpeed: 220, colour: '#cfe0ff', maxLife: 0.16,
          });
          break;
        case 'crewDown':
          state.toast = { text: `${ev.data.left} LEFT`, colour: PALETTE.neonRed, life: 1.6 };
          break;
        default:
          break;
      }
    }
    events.length = 0;
  }

  function damagePlayer(dmg) {
    const p = state.player;
    if (p.dead || p.invuln > 0) return;
    let left = dmg;
    if (p.armour > 0) {
      const absorbed = Math.min(p.armour, left * 0.7);
      p.armour -= absorbed;
      left -= absorbed;
    }
    p.health -= left;
    p.hurtFlash = Math.min(0.5, 0.18 + dmg / 60);
    state.camera.shake = Math.min(CAMERA.maxShake, state.camera.shake + dmg * 0.35);
    audio.play('hit');
    if (p.health <= 0) {
      p.health = 0;
      p.dead = true;
      p.deadTimer = 0;
      audio.play('death');
      if (p.inCar && p.car) {
        p.inCar = false;
        p.car = null;
      }
    }
  }

  /* ---------------------------------------------------------------- bullets */

  function stepBullets(dt) {
    const bs = state.bullets;
    for (let i = bs.length - 1; i >= 0; i -= 1) {
      const b = bs[i];
      b.px = b.x;
      b.py = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      let dead = b.life <= 0;
      if (!dead) {
        // Buildings.
        for (let k = 0; k < state.city.solids.length; k += 1) {
          const s = state.city.solids[k];
          if (b.x > s.x && b.x < s.x + s.w && b.y > s.y && b.y < s.y + s.h) {
            dead = true;
            addParticles(state, b.x, b.y, 4, { colour: b.colour, maxSpeed: 110, maxLife: 0.22 });
            break;
          }
        }
      }
      if (!dead && b.friendly) {
        // Pedestrians.
        for (let k = 0; k < state.peds.length; k += 1) {
          const ped = state.peds[k];
          if (ped.dead) continue;
          if (Math.abs(ped.x - b.x) < 10 && Math.abs(ped.y - b.y) < 10) {
            ped.health -= b.damage;
            ped.hurt = 3;
            ped.panicked = 4;
            ped.panicFrom = { x: b.px, y: b.py };
            addParticles(state, b.x, b.y, 5, { colour: PALETTE.blood, maxSpeed: 100 });
            dead = true;
            if (ped.health <= 0) killPed(ped, true);
            break;
          }
        }
        // Cops on foot.
        if (!dead) {
          for (let k = 0; k < state.cops.length; k += 1) {
            const cop = state.cops[k];
            if (cop.mode !== 'foot') continue;
            if (Math.abs(cop.x - b.x) < 10 && Math.abs(cop.y - b.y) < 10) {
              cop.health -= b.damage;
              addParticles(state, b.x, b.y, 5, { colour: '#9fb6ff', maxSpeed: 110 });
              dead = true;
              if (cop.health <= 0) {
                state.cops.splice(k, 1);
                commitCrime(state, WANTED.killCop);
                state.stats.kills += 1;
                audio.play('hit');
              }
              break;
            }
          }
        }
        // Cars: damage the body, and the driver if there is one.
        if (!dead) {
          for (let k = 0; k < state.cars.length; k += 1) {
            const car = state.cars[k];
            if (car.wrecked) continue;
            const dx = b.x - car.x;
            const dy = b.y - car.y;
            const fwdX = Math.cos(car.angle);
            const fwdY = Math.sin(car.angle);
            const along = dx * fwdX + dy * fwdY;
            const across = -dx * fwdY + dy * fwdX;
            if (Math.abs(along) < car.spec.len * 0.5 && Math.abs(across) < car.spec.wid * 0.5) {
              car.health -= b.damage * 0.55;
              car.bulletHoles.push({ x: along, y: across });
              addParticles(state, b.x, b.y, 4, { colour: '#ffe27a', maxSpeed: 120 });
              dead = true;
              if (car.mission === 'coda' || car === state.runnerVan) car.health -= b.damage * 0.4;
              if (car.police) commitCrime(state, 0.15);
              if (car.health <= 0 && !car.wrecked) {
                car.wrecked = true;
                addParticles(state, car.x, car.y, 24, { colour: '#ffb648', kind: 'smoke', maxLife: 1.6, maxSize: 6 });
                if (car.police) commitCrime(state, WANTED.killCop * 0.5);
                state.camera.shake = 12;
                audio.play('carHit');
              }
              break;
            }
          }
        }
      } else if (!dead && !b.friendly) {
        // Enemy fire hits the player and their car.
        const p = state.player;
        if (!p.inCar) {
          if (Math.abs(p.x - b.x) < 11 && Math.abs(p.y - b.y) < 11) {
            damagePlayer(b.damage);
            dead = true;
          }
        } else if (p.car) {
          const car = p.car;
          const along = (b.x - car.x) * Math.cos(car.angle) + (b.y - car.y) * Math.sin(car.angle);
          const across = -(b.x - car.x) * Math.sin(car.angle) + (b.y - car.y) * Math.cos(car.angle);
          if (Math.abs(along) < car.spec.len * 0.5 && Math.abs(across) < car.spec.wid * 0.5) {
            damagePlayer(b.damage * 0.45);
            car.health -= b.damage * 0.5;
            dead = true;
          }
        }
      }
      if (dead || b.x < 0 || b.y < 0 || b.x > state.city.size + 200 || b.y > state.city.size + 200) {
        bs.splice(i, 1);
      }
    }
  }

  /* ---------------------------------------------------------------- pickups */

  function stepPickups(dt) {
    const p = state.player;
    for (let i = 0; i < state.pickups.length; i += 1) {
      const pk = state.pickups[i];
      if (pk.taken) continue;
      if (dist(p.x, p.y, pk.x, pk.y) > 26) continue;
      pk.taken = true;
      if (pk.kind === 'health') {
        p.health = Math.min(100, p.health + pk.value);
        state.toast = { text: `+${pk.value} HEALTH`, colour: PALETTE.neonRed, life: 1.5 };
        audio.play('pickup');
      } else if (pk.kind === 'armour') {
        p.armour = Math.min(100, p.armour + pk.value);
        state.toast = { text: `+${pk.value} ARMOUR`, colour: PALETTE.policeBlue, life: 1.5 };
        audio.play('pickup');
      } else if (pk.kind === 'ammo') {
        p.ammo.smg += pk.value;
        p.ammo.shotgun += Math.ceil(pk.value / 3);
        p.hasWeapon.smg = true;
        p.hasWeapon.shotgun = true;
        state.toast = { text: `+${pk.value} AMMO`, colour: PALETTE.neonAmber, life: 1.5 };
        audio.play('pickup');
      } else {
        p.money += pk.value;
        addFloater(state, pk.x, pk.y - 12, `+${money(pk.value)}`, PALETTE.money);
        audio.play('cash');
      }
    }
  }

  /* ---------------------------------------------------------------- loop */

  function step(dt) {
    state.clock += dt;
    state.time += dt;
    state.frame += 1;
    const p = state.player;

    // Timers.
    p.invuln = Math.max(0, p.invuln - dt);
    p.fireCd = Math.max(0, p.fireCd - dt);
    p.meleeCd = Math.max(0, p.meleeCd - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt * 1.6);
    p.recoil *= Math.exp(-8 * dt);
    if (p.aiming) p.aiming = false;

    if (p.dead) {
      p.deadTimer += dt;
      if (p.deadTimer > 2.6) respawn();
      updateWorldWithoutPlayer(dt);
      return;
    }

    // Interaction: enter/exit car, missions, melee.
    if (input.hit('KeyF')) {
      if (state.active && !p.inCar && state.missionIndex < state.missions.length) {
        // F does double duty: leave a car, or talk to a contact standing at the marker.
        const m = state.missions[state.missionIndex];
        if (dist(p.x, p.y, m.x, m.y) < 70 && tryStartMission(state)) {
          announce(`Mission started: ${m.title}`);
        } else enterExitVehicle();
      } else enterExitVehicle();
    }
    if (input.hit('KeyE')) {
      if (state.missionIndex < state.missions.length && !state.active) {
        const m = state.missions[state.missionIndex];
        if (dist(p.x, p.y, m.x, m.y) < 70 && tryStartMission(state)) {
          announce(`Mission started: ${m.title}`);
        } else meleeAttack();
      } else meleeAttack();
    }
    if (input.hit('Digit1')) { if (state.player.hasWeapon.sidearm) p.weapon = 'sidearm'; }
    if (input.hit('Digit2') && p.hasWeapon.smg) p.weapon = 'smg';
    if (input.hit('Digit3') && p.hasWeapon.shotgun) p.weapon = 'shotgun';

    // Aim / fire.
    const mouse = input.mouse;
    const aim = renderer.toWorld(mouse.x, mouse.y, state.camera);
    if (!p.inCar) {
      if (mouse.down || input.down('Space')) {
        p.aiming = true;
        if (mouse.down) firePlayer();
      }
      // Melee with a click when empty-handed is handled by the E key; keep LMB purely firing.
    } else if (p.car) {
      // Drive-by is out of scope, but the aim cursor still points the way the car faces.
    }

    // Movement.
    if (p.inCar) {
      driveStep(dt);
    } else {
      let mx = 0;
      let my = 0;
      if (input.down('KeyW', 'ArrowUp')) my -= 1;
      if (input.down('KeyS', 'ArrowDown')) my += 1;
      if (input.down('KeyA', 'ArrowLeft')) mx -= 1;
      if (input.down('KeyD', 'ArrowRight')) mx += 1;
      if (mx || my) {
        const len = Math.hypot(mx, my);
        mx /= len; my /= len;
      }
      const sprint = input.down('ShiftLeft', 'ShiftRight');
      stepFootPlayer(state, { mx, my }, dt, sprint);
      if (!p.aiming && (mx || my)) p.angle = Math.atan2(my, mx);
    }

    stepMissions(state, dt);
    state.objective = currentObjective(state);
    state.missionMarker = missionMarker(state);

    // Traffic and AI.
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (car === p.car) continue;
      if (car.police && car.driver === null && car.brake) continue;
      if (car.wrecked) continue;
      if (car.rail && !car.parked) {
        const slow = car.mission === 'runner' ? 1.1 : 1;
        stepCarRail(state, car, dt, slow);
      } else if (car.parked) {
        car.vx *= 0.9; car.vy *= 0.9;
        car.x += car.vx * dt; car.y += car.vy * dt;
        collideCarBuildings(state, car);
      }
    }
    // The mission van runs from the cops and the player: give it a driver that flees.
    if (state.runnerVan && state.active && state.active.def.id === 'chase' && !state.runnerVan.wrecked) {
      const van = state.runnerVan;
      if (van.driver === null) { van.driver = { npc: true }; van.rail = true; van.railSpeed = 165; }
    }

    stepCopCars(state, dt);
    stepAi(state, dt);
    stepBullets(dt);
    collideCars(state);
    separateWalkers(state);
    runOverCheck(state);
    stepPickups(dt);
    stepWanted(state, dt);
    handleEvents();

    // Particles and floaters.
    for (let i = state.particles.length - 1; i >= 0; i -= 1) {
      const pt = state.particles[i];
      pt.life -= dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx -= pt.vx * pt.drag * dt;
      pt.vy -= pt.vy * pt.drag * dt;
      if (pt.life <= 0) state.particles.splice(i, 1);
    }
    for (let i = state.floaters.length - 1; i >= 0; i -= 1) {
      const f = state.floaters[i];
      f.life -= dt;
      f.y += f.vy * dt;
      f.vy *= 0.94;
      if (f.life <= 0) state.floaters.splice(i, 1);
    }
    for (let i = state.skids.length - 1; i >= 0; i -= 1) {
      state.skids[i].life -= dt;
      if (state.skids[i].life <= 0) state.skids.splice(i, 1);
    }
    if (state.toast) {
      state.toast.life -= dt;
      if (state.toast.life <= 0) state.toast = null;
    }

    updateCamera(state, dt);
    updateAudio();
  }

  /** While the player is down, keep the city moving so the death screen is not frozen. */
  function updateWorldWithoutPlayer(dt) {
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (car.rail && !car.parked && !car.wrecked) stepCarRail(state, car, dt);
    }
    stepAi(state, dt);
    stepCopCars(state, dt);
    stepBullets(dt);
    collideCars(state);
    for (let i = state.particles.length - 1; i >= 0; i -= 1) {
      const pt = state.particles[i];
      pt.life -= dt;
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      if (pt.life <= 0) state.particles.splice(i, 1);
    }
    updateCamera(state, dt);
  }

  function respawn() {
    const p = state.player;
    const fee = Math.floor(p.money * DEATH_PENALTY);
    p.money = Math.max(0, p.money - fee);
    p.dead = false;
    p.health = 100;
    p.armour = 0;
    p.wanted = 0;
    p.heat = 0;
    p.invuln = 3;
    p.deadTimer = 0;
    p.inCar = false;
    p.car = null;
    p.vx = 0; p.vy = 0;
    p.weapon = 'sidearm';
    p.ammo.smg = 0;
    p.ammo.shotgun = 0;
    const h = state.places.hospital;
    p.x = h.x - 60;
    p.y = h.y + 120;
    state.cops.length = 0;
    state.camera.x = p.x;
    state.camera.y = p.y;
    state.bannerText = { title: 'PATCHED UP', sub: `The hospital took ${money(fee)}. The city kept the rest.`, colour: PALETTE.neonRed };
    state.missionBannerT = 4.5;
    // A failed job is quietly reset so it can be tried again.
    if (state.active) {
      state.active.failed = true;
      state.active = null;
      state.objective = currentObjective(state);
    }
    announce('Respawned at the hospital.');
  }

  function updateAudio() {
    const p = state.player;
    const speed = p.inCar && p.car ? Math.hypot(p.car.vx, p.car.vy) : 0;
    let copsNear = 0;
    for (let i = 0; i < state.cops.length; i += 1) {
      const c = state.cops[i];
      const cx = c.car ? c.car.x : c.x;
      const cy = c.car ? c.car.y : c.y;
      if (dist(cx, cy, p.x, p.y) < 700) copsNear += 1;
    }
    audio.update({
      speed,
      maxSpeed: p.car ? p.car.spec.maxSpeed : 200,
      driving: p.inCar,
      copsNear,
      wanted: p.wanted,
    });
  }

  /* ---------------------------------------------------------------- save / load */

  function doSave() {
    const p = state.player;
    const ok = writeSave({
      version: 2,
      at: Date.now(),
      money: p.money,
      health: Math.max(35, Math.round(p.health)),
      armour: Math.round(p.armour),
      pos: { x: Math.round(p.x), y: Math.round(p.y) },
      ammo: { smg: p.ammo.smg, shotgun: p.ammo.shotgun },
      weapon: p.weapon,
      hasWeapon: p.hasWeapon,
      missionIndex: state.missionIndex,
      missionsDone: state.stats.missionDone,
    });
    save = readSave();
    saveFlash = 2.2;
    state.toast = { text: ok ? 'NIGHT SAVED' : 'SAVE UNAVAILABLE', colour: ok ? PALETTE.money : PALETTE.neonRed, life: 2.4 };
    audio.play('mission');
  }

  /* ---------------------------------------------------------------- screens */

  function startNewGame() {
    audio.unlock();
    freshWorld();
    screen = SCREEN_PLAY;
    input.pressed.clear();
    announce('Neon Haven. You are on foot near the lock-up.');
    state.bannerText = { title: 'NEON HAVEN', sub: 'Find your contact at the diamond on the map. Press F to talk.', colour: PALETTE.neonCyan };
    state.missionBannerT = 6;
  }

  function continueGame() {
    const s = readSave();
    if (!s) { startNewGame(); return; }
    audio.unlock();
    freshWorld({ player: s, missionIndex: s.missionIndex ?? 0 });
    screen = SCREEN_PLAY;
    input.pressed.clear();
    state.toast = { text: 'NIGHT RESTORED', colour: PALETTE.money, life: 2.4 };
    announce('Continued from your last save.');
  }

  function handleMenu() {
    if (input.hit('Enter', 'NumpadEnter')) {
      if (save) continueGame();
      else startNewGame();
    } else if (input.hit('KeyN') && save) {
      startNewGame();
    }
  }

  function handlePlayKeys() {
    if (input.hit('Escape')) {
      screen = 'paused';
      announce('Paused.');
      return;
    }
    if (input.hit('KeyM')) audio.setMuted(false);
    if (input.hit('KeyK')) doSave();
  }

  function handlePauseKeys() {
    if (input.hit('Escape')) {
      screen = SCREEN_PLAY;
      announce('Playing.');
    } else if (input.hit('KeyS')) {
      doSave();
    } else if (input.hit('KeyQ')) {
      screen = SCREEN_TITLE;
      save = readSave();
      announce('Returned to the title screen.');
    }
  }

  /* ---------------------------------------------------------------- frame */

  function frame(now) {
    requestAnimationFrame(frame);
    const delta = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (screen === SCREEN_TITLE) {
      handleMenu();
      // The title runs the city behind the glass so it is never a still image.
      accumulator += delta;
      let guard = 0;
      while (accumulator >= STEP && guard < 3) {
        titleStep(STEP);
        accumulator -= STEP;
        guard += 1;
      }
      renderer.draw(state, SCREEN_TITLE, {});
      hud.drawTitle(state, save ? 1 : 0);
      input.endFrame();
      return;
    }

    if (screen === 'paused') {
      handlePauseKeys();
      renderer.draw(state, 'play', { aim: null });
      hud.draw(state, 'paused', {});
      input.endFrame();
      return;
    }

    handlePlayKeys();
    accumulator += delta;
    let guard = 0;
    while (accumulator >= STEP && guard < 5) {
      step(STEP);
      accumulator -= STEP;
      guard += 1;
    }
    if (accumulator > STEP * 5) accumulator = 0;

    const aim = renderer.toWorld(input.mouse.x, input.mouse.y, state.camera);
    renderer.draw(state, SCREEN_PLAY, {
      aim: state.player.inCar || state.player.dead ? null : { sx: input.mouse.x, sy: input.mouse.y, wx: aim.x, wy: aim.y },
    });
    if (state.player.dead) hud.drawDeath(state);
    hud.draw(state, SCREEN_PLAY, {});
    input.endFrame();
  }

  /** The title screen's living backdrop: traffic and peds, no player, no danger. */
  function titleStep(dt) {
    state.clock += dt;
    state.time += dt;
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (car.rail && !car.parked && !car.wrecked) stepCarRail(state, car, dt);
    }
    stepAi(state, dt);
    for (let i = state.particles.length - 1; i >= 0; i -= 1) {
      const pt = state.particles[i];
      pt.life -= dt;
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      if (pt.life <= 0) state.particles.splice(i, 1);
    }
    state.camera.x += (state.places.park.x - state.camera.x) * 0.02;
    state.camera.y += (state.places.park.y - state.camera.y) * 0.02;
    state.camera.zoom += (0.78 - state.camera.zoom) * 0.02;
  }

  /* ---------------------------------------------------------------- boot */

  freshWorld();
  state.clock = 0;

  if (shotName) {
    // Screenshot mode: stage the named scene, paint it twice, then signal the harness.
    const { stageShot } = window.__shots ?? {};
    import('./shots.js').then(({ stageShot }) => {
      stageShot(shotName, state, { renderer, hud, city });
      let painted = 0;
      function paint() {
        // Each scene decides what the crosshair is aimed at; a fixed screen point would leave the
        // reticle pointing at bare asphalt in every shot.
        let aim = state.shotAim;
        if (!aim) {
          aim = { sx: VIEW.width * 0.66, sy: VIEW.height * 0.42, wx: state.player.x + 120, wy: state.player.y - 60 };
        } else {
          const s = renderer.toScreen(aim.wx, aim.wy, state.camera);
          aim = { sx: s.x, sy: s.y, wx: aim.wx, wy: aim.wy };
        }
        renderer.draw(state, SCREEN_PLAY, { aim });
        if (state.shotTitle) hud.drawTitle(state, 0);
        else hud.draw(state, SCREEN_PLAY, {});
        painted += 1;
        if (painted < 2) requestAnimationFrame(paint);
        else window.__shotReady = true;
      }
      requestAnimationFrame(paint);
    });
    return;
  }

  audio.unlock();
  announce('Neon Haven. Press Enter to start.');
  requestAnimationFrame(frame);
}
