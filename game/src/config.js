// Every tunable in one place: the view, the projection, the city grid, palette, vehicle and
// weapon tables, wanted-level rules, mission economy. Nothing here imports anything.

/** The logical render area; the canvas is scaled to fit the window. */
export const VIEW = { width: 1280, height: 720 };

/** Fixed simulation step: 60 updates a second whatever the display does. */
export const STEP = 1 / 60;

/** Vertical squash of the ground plane: the oblique camera angle. 1 would be straight down. */
export const YSQ = 0.78;

/** The city grid: `grid x grid` cells, each a road plus a block. Streets run on every cell line. */
export const WORLD = { grid: 11, cell: 300, road: 76, lane: 18 };
WORLD.size = WORLD.grid * WORLD.cell;

/** Height of the water table on the east edge, in world units past the last street. */
export const QUAY = { wall: 34, width: 1400 };

export const PALETTE = {
  sky: '#06050d',
  fogFar: '#150f2b',
  fogNear: '#0b0a16',
  asphalt: '#252334',
  asphaltWarm: '#2c2639',
  sidewalk: '#3a3850',
  curb: '#5b5878',
  lane: '#cfc9e4',
  grass: '#1b3229',
  grassLit: '#26463a',
  water: '#071018',
  waterLit: '#0d2130',
  neonCyan: '#3ff2e4',
  neonMagenta: '#ff3f9c',
  neonAmber: '#ffb648',
  neonViolet: '#a273ff',
  neonRed: '#ff3d4d',
  neonLime: '#93ff6b',
  policeRed: '#ff2b4a',
  policeBlue: '#3d7bff',
  text: '#eef4ff',
  muted: '#8b93ab',
  money: '#86ffa8',
  blood: '#8e1430',
};

export const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';
export const MONO = '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';

/** Player on foot. */
export const FOOT = {
  walk: 82,
  sprint: 138,
  radius: 9,
  accel: 900,
  friction: 12,
  maxHealth: 100,
  maxArmour: 100,
  respawnInvuln: 2.5,
  meleeRange: 34,
  meleeDamage: 38,
  meleeCooldown: 0.45,
};

/** Vehicle handling table. `len`/`wid` are world units; speeds are units per second. */
export const VEHICLES = {
  sedan: { name: 'Sedan', len: 46, wid: 23, maxSpeed: 206, accel: 168, brake: 300, turn: 2.45, mass: 1, health: 190, value: 120 },
  taxi: { name: 'Taxi', len: 48, wid: 24, maxSpeed: 214, accel: 176, brake: 300, turn: 2.5, mass: 1.05, health: 200, value: 150 },
  van: { name: 'Van', len: 56, wid: 27, maxSpeed: 172, accel: 128, brake: 250, turn: 2.0, mass: 1.5, health: 260, value: 220 },
  sports: { name: 'Coda', len: 46, wid: 22, maxSpeed: 292, accel: 272, brake: 340, turn: 3.05, mass: 0.9, health: 160, value: 900 },
  muscle: { name: 'Muscle', len: 50, wid: 25, maxSpeed: 242, accel: 224, brake: 290, turn: 2.6, mass: 1.15, health: 210, value: 340 },
  police: { name: 'Cruiser', len: 50, wid: 25, maxSpeed: 252, accel: 236, brake: 310, turn: 2.9, mass: 1.2, health: 240, value: 0 },
  swat: { name: 'Riot', len: 58, wid: 29, maxSpeed: 214, accel: 180, brake: 300, turn: 2.2, mass: 1.8, health: 380, value: 0 },
};

export const VEHICLE_PAINT = {
  sedan: ['#2f3b52', '#3d3346', '#2b4a44', '#4a3f34', '#37414f'],
  taxi: ['#d8a52a', '#e0b13a'],
  van: ['#3a3f4d', '#45403a', '#2f3a44'],
  sports: ['#161320', '#241426', '#12222b'],
  muscle: ['#5a2430', '#33405a', '#4a4526'],
  police: ['#e9eef7'],
  swat: ['#23283a'],
};

/** Weapons: the sidearm never runs dry; the rest need ammo. */
export const WEAPONS = {
  sidearm: { name: 'SIDEARM', damage: 26, rate: 0.24, speed: 980, spread: 0.045, ammo: Infinity, tracer: PALETTE.neonCyan, kick: 1.6, sound: 'pistol' },
  smg: { name: 'SMG', damage: 17, rate: 0.085, speed: 1060, spread: 0.09, ammo: 0, tracer: '#ffe27a', kick: 1.1, sound: 'smg' },
  shotgun: { name: 'SHOTGUN', damage: 15, rate: 0.75, speed: 900, spread: 0.2, pellets: 7, ammo: 0, tracer: '#ffb27a', kick: 4.2, sound: 'shotgun' },
};

export const WEAPON_ORDER = ['sidearm', 'smg', 'shotgun'];

/** Wanted rules: what a crime is worth, and how long out of sight cools a star. */
export const WANTED = {
  max: 5,
  shootNearCop: 0.34,
  killCivilian: 0.55,
  killCop: 1.0,
  stealCar: 0.1,
  coolPerSecond: 0.055,
  coolDelay: 3.5,
  heatPerStar: 1,
};

/** Mission economy. */
export const SAVE_KEY = 'neon-haven.save.v2';
export const DEATH_PENALTY = 0.12;

export const CAMERA = {
  follow: 7.5,
  lookAhead: 0.34,
  maxShake: 18,
  footZoom: 1,
};
