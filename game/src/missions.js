// The mission chain: five jobs from three characters, each one harder than the last, with an
// objective, a timer or a fail state, a reward and a story beat between them. The state machine
// here is the only place that knows the order; the HUD and the renderer only read `state.mission`.
//
// Missions are data plus small step functions: `start`, `update`, `onKill`, `onReach`, `reward`.
import { PALETTE } from './config.js';
import { dist, money, clamp } from './util.js';
import { makeCar, spawnPed, addFloater } from './world.js';
import { commitCrime } from './ai.js';

export const CHARACTERS = {
  vex: { name: 'VEX', tag: 'fixer', color: PALETTE.neonMagenta, line: 'You look like you can drive.' },
  sable: { name: 'MAMA SABLE', tag: 'salt market', color: PALETTE.neonAmber, line: 'Nobody moves weight on my corner but me.' },
  hollow: { name: 'DOCTOR HOLLOW', tag: 'ripper', color: PALETTE.neonCyan, line: 'Everything in this city is for sale. Even the ending.' },
};

/**
 * Each mission: id, giver, title, brief (one line on the banner), text (the fuller objective),
 * reward, optional time, and the marker. A marker is a world point the player must reach to
 * start; the giver stands there.
 */
export const MISSION_DEFS = [
  {
    id: 'courier',
    giver: 'vex',
    title: 'DEAD DROP',
    brief: 'Run the package across the Lantern Row line before the clock kills it.',
    reward: 900,
    time: 105,
    marker: 'garage',
    delivery: 'pier',
    steps: ['Get to the lock-up and collect the case', 'Deliver it to the pier before the timer dies'],
  },
  {
    id: 'repossess',
    giver: 'vex',
    title: 'THE CODA JOB',
    brief: 'A violet Coda is parked in Cinder Yard. It belongs to me again tonight.',
    reward: 1500,
    time: 0,
    marker: 'precinct',
    target: { type: 'sports', color: '#7a2bd6' },
    steps: ['Find the violet Coda in Cinder Yard', 'Bring it back to the lock-up in one piece'],
  },
  {
    id: 'crew',
    giver: 'sable',
    title: 'SALT & RUST',
    brief: 'Six of Hollow\'s boys are leaning on my market. Lean back.',
    reward: 2400,
    time: 0,
    marker: 'park',
    kills: 6,
    steps: ['Go to the Salt Market and clear out the crew', 'Survive — they will shoot back'],
  },
  {
    id: 'chase',
    giver: 'sable',
    title: 'RUNNING LIGHT',
    brief: 'A courier is carrying my ledger out of the district. Stop the car, keep the book.',
    reward: 3600,
    time: 130,
    marker: 'docks',
    chase: true,
    steps: ['Get to the docks and find the black van', 'Wreck it or box it in before it escapes'],
  },
  {
    id: 'finale',
    giver: 'hollow',
    title: 'LAST LIGHT ON THE PIER',
    brief: 'Hollow is leaving on the tide. The city is yours if he does not.',
    reward: 9000,
    time: 0,
    marker: 'pier',
    finale: true,
    steps: ['Meet Hollow on the pier', 'Put him down before the chopper lands'],
  },
];

/** Character spawn points, near their markers. */
function placeGiver(state, def) {
  const marker = state.places[def.marker];
  const giver = CHARACTERS[def.giver];
  return {
    id: def.id,
    giverId: def.giver,
    name: giver.name,
    colour: giver.color,
    x: marker.x + 46,
    y: marker.y + 30,
    title: def.title,
    brief: def.brief,
    steps: def.steps,
    reward: def.reward,
    time: def.time,
    started: false,
    complete: false,
    failed: false,
    step: 0,
    timer: 0,
    target: null,
    targetCar: null,
    kills: 0,
    killsNeeded: def.kills ?? 0,
    def,
  };
}

export function createMissions(state) {
  const missions = MISSION_DEFS.map((def) => placeGiver(state, def));
  return missions;
}

/**
 * Mission runtime. `state.missions` holds the chain; `state.active` is the one running (or null);
 * `state.missionIndex` is the next available. The renderer asks `missionMarkers()` for the world
 * markers to draw.
 */
export function setupMissions(state) {
  state.missions = createMissions(state);
  state.missionIndex = 0;
  state.active = null;
  state.missionBannerT = 0;
  spawnMissionActors(state);
}

/** Physical actors: the crew to wipe out and the van to stop exist in the world from the start. */
export function spawnMissionActors(state) {
  // Salt Market crew: six armed men standing around the market square.
  const market = state.places.park;
  state.crew = [];
  for (let i = 0; i < 6; i += 1) {
    const ang = (i / 6) * Math.PI * 2;
    const ped = spawnPed(state, market.x + Math.cos(ang) * 54, market.y + Math.sin(ang) * 54, { kind: 'thug' });
    ped.health = 46;
    ped.armed = true;
    ped.shootCd = 0;
    ped.crew = 'hollow';
    ped.colour = '#2a1c2c';
    state.crew.push(ped);
    state.peds.push(ped);
  }
  // The courier van for mission 4, parked at the docks until it is called.
  const docks = state.places.docks;
  state.runnerVan = makeCar(state, 'van', docks.x + 30, docks.y + 90, Math.PI, { color: '#141018' });
  state.runnerVan.driver = null;
  state.runnerVan.parked = true;
  // Hollow's escort at the pier: four heavies and Hollow himself.
  const pier = state.places.pier;
  state.escort = [];
  for (let i = 0; i < 3; i += 1) {
    const ped = spawnPed(state, pier.x - 20 + i * 26, pier.y - 40, { kind: 'thug' });
    ped.health = 70;
    ped.armed = true;
    ped.colour = '#1b2230';
    ped.escort = true;
    state.escort.push(ped);
    state.peds.push(ped);
  }
  const boss = spawnPed(state, pier.x + 20, pier.y - 60, { kind: 'boss' });
  boss.health = 260;
  boss.armed = true;
  boss.boss = true;
  boss.colour = '#2a1030';
  boss.skin = '#d7b49a';
  state.boss = boss;
  state.peds.push(boss);
}

/** The next mission marker to draw, or null when the chain is done. */
export function missionMarker(state) {
  const idx = state.missionIndex;
  if (idx >= state.missions.length) return null;
  const m = state.missions[idx];
  return { x: m.x, y: m.y, colour: m.colour, name: m.giverId, title: m.title };
}

/** Called when the player presses F at a marker or reaches the objective. */
export function tryStartMission(state) {
  const idx = state.missionIndex;
  if (state.active || idx >= state.missions.length) return false;
  const m = state.missions[idx];
  const d = dist(state.player.x, state.player.y, m.x, m.y);
  if (d > 60) return false;
  beginMission(state, m);
  return true;
}

function beginMission(state, m) {
  state.active = m;
  m.started = true;
  m.step = 0;
  m.timer = m.time;
  m.kills = 0;
  if (m.def.id === 'courier') {
    m.caseCarry = false;
    m.target = { x: state.places.garage.x + 10, y: state.places.garage.y + 60 };
    state.objective = 'Collect the case at the lock-up';
  } else if (m.def.id === 'repossess') {
    // Park the target Coda in Cinder Yard, a few blocks from where the player is.
    if (!state.coda) {
      const spot = { x: 4 * 300 + 120, y: 1 * 300 + 210 };
      state.coda = makeCar(state, 'sports', spot.x, spot.y, 0.3, { color: '#7a2bd6' });
      state.coda.parked = true;
      state.coda.driver = { npc: true };
      state.coda.mission = 'coda';
    }
    state.objective = 'Steal the violet Coda in Cinder Yard';
  } else if (m.def.id === 'crew') {
    state.objective = 'Wipe out Hollow\'s crew at the Salt Market';
  } else if (m.def.id === 'chase') {
    // The van pulls away the moment the mission starts.
    state.runnerVan.parked = false;
    state.runnerVan.driver = { npc: true };
    state.runnerVan.rail = true;
    state.runnerVan.axis = 'h';
    state.runnerVan.dir = 1;
    state.runnerVan.railSpeed = 150;
    state.runnerVan.x = state.places.docks.x - 30;
    state.runnerVan.y = 8 * 300 + 17;
    state.runnerVan.health = 220;
    state.objective = 'Run down the black van before it leaves the city';
  } else if (m.def.id === 'finale') {
    state.boss.health = 260;
    state.boss.dead = false;
    state.objective = 'Kill Hollow on the pier';
  }
  state.missionBannerT = 5.5;
  const giver = CHARACTERS[m.giverId] || CHARACTERS[m.giver];
  state.bannerText = {
    title: m.title,
    sub: m.brief,
    colour: m.colour,
    speaker: giver ? giver.name : null,
    role: giver ? giver.tag : null,
  };
}

function completeMission(state, m) {
  m.complete = true;
  state.active = null;
  state.missionIndex += 1;
  state.player.money += m.reward;
  state.stats.missionDone += 1;
  state.bannerText = { title: 'MISSION COMPLETE', sub: `${m.title} — ${money(m.reward)}`, colour: PALETTE.money };
  state.missionBannerT = 5;
  state.objective = state.missionIndex < state.missions.length ? 'Meet your next contact' : 'The city is yours';
  addFloater(state, state.player.x, state.player.y - 30, `+${money(m.reward)}`, PALETTE.money);
  state.events.push({ name: 'missionComplete', data: { id: m.id } });
  if (state.missionIndex < state.missions.length) m.next = state.missions[state.missionIndex].giverId;
}

function failMission(state, m, reason) {
  m.failed = true;
  m.started = false;
  state.active = null;
  state.bannerText = { title: 'MISSION FAILED', sub: reason, colour: PALETTE.neonRed };
  state.missionBannerT = 5;
  state.objective = `Return to ${CHARACTERS[m.giverId].name} to try again`;
  state.events.push({ name: 'missionFailed' });
}

/** Per-frame mission logic. Runs before the AI so a mission can change the world state. */
export function stepMissions(state, dt) {
  if (state.missionBannerT > 0) state.missionBannerT = Math.max(0, state.missionBannerT - dt);
  const m = state.active;
  if (!m) {
    // Idle: a mission giver may be waiting; the marker is drawn from missionMarker().
    return;
  }
  if (m.timer > 0) {
    m.timer -= dt;
    if (m.timer <= 0) {
      failMission(state, m, 'Out of time.');
      return;
    }
  }
  const p = state.player;

  switch (m.def.id) {
    case 'courier': {
      if (m.step === 0) {
        if (dist(p.x, p.y, m.target.x, m.target.y) < 46) {
          m.step = 1;
          m.caseCarry = true;
          const dest = state.places[m.def.delivery];
          m.target = { x: dest.x, y: dest.y };
          state.objective = 'Deliver the case to the pier';
          state.bannerText = { title: 'CASE SECURED', sub: 'Now get it to the pier — do not stop', colour: PALETTE.neonAmber };
          state.missionBannerT = 4;
          commitCrime(state, 0.6);
        }
      } else if (dist(p.x, p.y, m.target.x, m.target.y) < 62) {
        completeMission(state, m);
      }
      break;
    }
    case 'repossess': {
      const car = state.coda;
      if (!car) break;
      if (m.step === 0) {
        if (p.inCar && p.car === car && car.health > 0) {
          m.step = 1;
          const g = state.places.garage;
          m.target = { x: g.x + 10, y: g.y + 70 };
          state.objective = 'Drive the Coda to the lock-up';
          commitCrime(state, 0.35);
        }
      } else if (p.inCar && p.car === car) {
        if (dist(car.x, car.y, m.target.x, m.target.y) < 80) completeMission(state, m);
      }
      if (car.health <= 0) failMission(state, m, 'The Coda is scrap.');
      break;
    }
    case 'crew': {
      if (m.kills >= m.killsNeeded) {
        completeMission(state, m);
      } else {
        state.objective = `Take out Hollow's crew — ${m.kills}/${m.killsNeeded}`;
      }
      break;
    }
    case 'chase': {
      const van = state.runnerVan;
      if (van.health <= 0 || van.wrecked) {
        completeMission(state, m);
        break;
      }
      if (!van.rail && Math.hypot(van.vx, van.vy) < 12 && !van.parked) {
        // Boxed in or stopped dead: also a win.
        m.stopTimer = (m.stopTimer ?? 0) + dt;
        if (m.stopTimer > 2.5) completeMission(state, m);
      } else {
        m.stopTimer = 0;
      }
      if (!state.active) break;
      // The van drives itself along the streets; it is fast enough to be a real chase.
      state.objective = `Stop the black van — ${Math.max(0, Math.round(180 - m.timer))}s`;
      break;
    }
    case 'finale': {
      if (state.boss.dead) {
        completeMission(state, m);
        break;
      }
      const d = dist(p.x, p.y, state.boss.x, state.boss.y);
      if (d < 520) {
        m.engaged = true;
        state.objective = `Kill Hollow — ${Math.max(0, Math.round(state.boss.health))} armour`;
      } else {
        state.objective = 'Get to the pier and find Hollow';
      }
      break;
    }
    default:
      break;
  }
  if (state.active === m) state.objective = state.objective;
}

/** What the HUD shows as the current job. */
export function currentObjective(state) {
  if (state.active) return state.objective;
  if (state.missionIndex >= state.missions.length) return 'The city is yours. Enjoy the lights.';
  const m = state.missions[state.missionIndex];
  return `${CHARACTERS[m.giverId].name} — ${m.title}`;
}

export function nextMission(state) {
  return state.missions[state.missionIndex] ?? null;
}

/** A kill event inside a mission that cares. */
export function onMissionKill(state, ped) {
  const m = state.active;
  if (!m) return;
  if (m.def.id === 'crew' && ped.crew === 'hollow') {
    m.kills += 1;
    state.events.push({ name: 'crewDown', data: { left: m.killsNeeded - m.kills } });
  }
}
