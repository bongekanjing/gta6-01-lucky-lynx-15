// City generation: one seeded layout, no randomness at runtime. Streets sit on every cell line of
// the grid, blocks (with sidewalks and a waterfront park) fill the gaps, and each block is
// subdivided into buildings with a footprint, a height, a wall colour and often a neon sign.
// Everything downstream (collision, rendering, the minimap, traffic) reads this one structure.
import { PALETTE, WORLD } from './config.js';
import { createRandom, rand, randInt, pick, clamp } from './util.js';

const CELL = WORLD.cell;
const ROAD = WORLD.road;
const SIDEWALK = 22;
const STREET_NAMES = [
  'Marrow Ave', 'Dell St', 'Lantern Way', 'Cinder St', 'Vesper Blvd', 'Halo Row',
  'Kestrel St', 'Saffron Ave', 'Copper Lane', 'Pale St', 'Onyx Way', 'Vellum St',
  'Amber Row', 'Quill Ave', 'Sable St', 'Wick Lane', 'Harbour Rd', 'Tide Walk',
];
const DISTRICTS = [
  { name: 'LANTERN ROW', x: 0, y: 0, w: 4, h: 4 },
  { name: 'CINDER YARD', x: 4, y: 0, w: 3, h: 4 },
  { name: 'HALCYON SPIRE', x: 7, y: 0, w: 4, h: 3 },
  { name: 'VAPOR DOCKS', x: 7, y: 3, w: 4, h: 4 },
  { name: 'SALT MARKET', x: 0, y: 4, w: 4, h: 4 },
  { name: 'VIOLET WARD', x: 4, y: 4, w: 3, h: 3 },
  { name: 'EMBER HILL', x: 0, y: 8, w: 5, h: 3 },
  { name: 'GLASS BOTTOM', x: 5, y: 7, w: 6, h: 4 },
];
const SHOP_SIGNS = [
  'NOODLE', 'PAWN', 'HOTEL', 'LIQUOR', 'TATTOO', 'ARCADE', 'RAMEN', 'MOTEL',
  'BODEGA', 'BANK', 'DINER', 'CLINIC', 'PHARMA', 'CINEMA', '24H', 'JADE SPA',
  'VAPOR', 'CHROME', 'STATIC', 'NEON', 'LOTUS', 'DELTA', 'ECHO', 'SILK',
];
const WALL_COLORS = ['#1e2233', '#22283b', '#1b2030', '#282a3a', '#232032', '#1d2a33', '#2a2435', '#1f2930'];
const NEONS = [
  PALETTE.neonCyan, PALETTE.neonMagenta, PALETTE.neonAmber,
  PALETTE.neonViolet, PALETTE.neonLime, PALETTE.neonRed,
];

/** True when the point is on a street (not sidewalk, not block). */
export function onRoad(x, y) {
  const modX = x % CELL;
  const modY = y % CELL;
  return modX > CELL - ROAD / 2 || modX < ROAD / 2 || modY > CELL - ROAD / 2 || modY < ROAD / 2;
}

/** The street cell index for a coordinate. */
const cellOf = (v) => Math.floor(v / CELL);

function buildingAt(rng, x, y, w, h, district) {
  // Halcyon Spire (2) is the downtown cluster; Ember Hill (6) sits on the rise. Heights are
  // deliberately generous so the oblique projection produces a real skyline instead of a texture.
  let height = Math.round(rand(rng, 52, 150));
  if (district === 2) height += Math.round(rand(rng, 90, 210));
  if (district === 6) height += Math.round(rand(rng, 30, 90));
  if (rng() < 0.08) height += 120;
  const wall = pick(rng, WALL_COLORS);
  const neon = rng() < 0.62 ? pick(rng, NEONS) : null;
  return {
    x, y, w, h,
    height,
    wall,
    roof: shade(wall, 0.62),
    trim: shade(wall, 1.35),
    windows: rng(),
    seed: Math.floor(rng() * 65535),
    neon,
    sign: neon ? pick(rng, SHOP_SIGNS) : null,
    signSide: rng() < 0.5 ? 'south' : 'east',
    hasRoofProp: rng() < 0.88,
    antenna: height > 190 && rng() < 0.7,
  };
}

function shade(hex, k) {
  const r = clamp(Math.round(parseInt(hex.slice(1, 3), 16) * k), 0, 255);
  const g = clamp(Math.round(parseInt(hex.slice(3, 5), 16) * k), 0, 255);
  const b = clamp(Math.round(parseInt(hex.slice(5, 7), 16) * k), 0, 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/**
 * Builds the whole city once. The returned object is read-only to everyone else:
 *   streets  — street centre lines, for traffic and the minimap
 *   blocks   — one per grid cell with its buildings and street furniture
 *   solids   — flat list of building footprints (collision + depth sorting)
 *   water    — the eastern waterfront rect
 */
export function generateCity(seed) {
  const rng = createRandom(seed ^ 0x9e3779b9);
  const size = WORLD.size;
  const grid = WORLD.grid;
  const blocks = [];
  const solids = [];
  const lights = [];
  const trees = [];
  const signs = [];

  const parkCell = { i: 1, j: 6 };

  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      const bx = i * CELL + ROAD / 2;
      const by = j * CELL + ROAD / 2;
      const bw = CELL - ROAD;
      const bh = CELL - ROAD;
      const isPark = i === parkCell.i && j === parkCell.j;
      const isPlaza = i === 5 && j === 5;
      const district = DISTRICTS.findIndex((d) => i >= d.x && j >= d.y && i < d.x + d.w && j < d.y + d.h);
      const block = {
        i, j, x: bx, y: by, w: bw, h: bh,
        district: district < 0 ? 0 : district,
        park: isPark,
        plaza: isPlaza,
        buildings: [],
      };
      blocks.push(block);

      if (isPark) {
        // The Salt Market: a paved square, not a lawn. Stalls ring the fountain, each with an
        // awning colour of its own so the square reads as commerce from above.
        const stalls = [];
        const AWNINGS = [PALETTE.neonRed, PALETTE.neonCyan, PALETTE.neonAmber,
          PALETTE.neonViolet, PALETTE.neonLime, PALETTE.neonMagenta];
        for (let s = 0; s < 10; s += 1) {
          const a = (s / 10) * Math.PI * 2 + 0.22;
          // Keep the whole stall inside the block: radius plus half the widest stall must clear
          // the sidewalk edge, or the market spills onto the road and reads as debris.
          const rr = rand(rng, 58, 76);
          stalls.push({
            x: bx + bw / 2 + Math.cos(a) * rr,
            y: by + bh / 2 + Math.sin(a) * rr,
            a: a + Math.PI / 2,
            w: rand(rng, 24, 32),
            h: rand(rng, 14, 19),
            awning: AWNINGS[s % AWNINGS.length],
            crate: rng() < 0.55,
          });
        }
        // A few trees at the kerb, outside the stall ring.
        for (let t = 0; t < 6; t += 1) {
          trees.push({
            x: bx + 16 + (t % 3) * (bw - 32) / 2,
            y: (t < 3 ? by + 12 : by + bh - 12) + rand(rng, -5, 5),
            r: rand(rng, 9, 14),
            t: rng(),
          });
        }
        block.stalls = stalls;
        block.fountain = { x: bx + bw / 2, y: by + bh / 2, r: 26 };
        continue;
      }
      if (isPlaza) {
        block.plazaProps = true;
        continue;
      }

      // Inside the sidewalk: the buildable lot.
      const lx = bx + SIDEWALK;
      const ly = by + SIDEWALK;
      const lw = bw - SIDEWALK * 2;
      const lh = bh - SIDEWALK * 2;

      // Split the lot into a 1x1, 2x1 or 2x2 arrangement of buildings, randomly.
      const cols = rng() < 0.55 ? 2 : 1;
      const rows = rng() < 0.45 ? 2 : 1;
      const gapX = cols === 2 ? 14 : 0;
      const gapY = rows === 2 ? 14 : 0;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          if (rng() < 0.12 && (cols > 1 || rows > 1)) continue; // a gap: a car park or alley
          const w = Math.round((lw - gapX * (cols - 1)) / cols - rand(rng, 0, 10));
          const h = Math.round((lh - gapY * (rows - 1)) / rows - rand(rng, 0, 10));
          if (w < 34 || h < 34) continue;
          const x = Math.round(lx + c * (lw - gapX * (cols - 1)) / cols + (c === cols - 1 ? lw - w - c * 0 : 0));
          const y = Math.round(ly + r * (lh - gapY * (rows - 1)) / rows + (r === rows - 1 ? lh - h - r * 0 : 0));
          const b = buildingAt(rng, clamp(x, lx, lx + lw - w), clamp(y, ly, ly + lh - h), w, h, block.district);
          block.buildings.push(b);
          solids.push(b);
          if (b.neon) signs.push({ x: b.x + b.w * 0.5, y: b.y + b.h, color: b.neon, text: b.sign, height: b.height, side: b.signSide, w: b.w });
        }
      }

      // Street lights at the four corners of the block, on the kerb.
      lights.push({ x: bx + 4, y: by + 4 }, { x: bx + bw - 4, y: by + 4 });
      lights.push({ x: bx + 4, y: by + bh - 4 }, { x: bx + bw - 4, y: by + bh - 4 });
    }
  }

  // The waterfront: everything east of the last street is water, with a quay wall.
  const waterX = size + ROAD / 2;
  const water = { x: waterX, y: -400, w: 1600, h: size + 900 };

  // A pier running out over the water — the finale happens here.
  const pier = { x: waterX, y: 1550, w: 260, h: 120 };

  const streets = { xs: [], ys: [] };
  for (let i = 0; i <= grid; i += 1) {
    streets.xs.push(i * CELL - ROAD / 2);
    streets.ys.push(i * CELL - ROAD / 2);
  }

  return {
    seed,
    size,
    cell: CELL,
    road: ROAD,
    grid,
    blocks,
    solids,
    lights,
    trees,
    signs,
    water,
    pier,
    streets,
    parkBlock: blocks[grid * parkCell.j + parkCell.i],
    districtName(x, y) {
      const d = DISTRICTS.find((dd) => x / CELL >= dd.x && y / CELL >= dd.y && x / CELL < dd.x + dd.w && y / CELL < dd.y + dd.h);
      return d ? d.name : 'NEON HAVEN';
    },
    streetName(x, y) {
      const idx = (Math.floor(x / CELL) * 3 + Math.floor(y / CELL) * 7) % STREET_NAMES.length;
      return STREET_NAMES[idx];
    },
  };
}

/** Is the point inside any building footprint? Returns the building or null. */
export function solidAt(city, x, y) {
  for (let i = 0; i < city.solids.length; i += 1) {
    const s = city.solids[i];
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
  }
  return null;
}

/** Buildings near a point, via a coarse grid bucket kept on the city. */
export function buildSolidIndex(city) {
  const bucket = new Map();
  const B = 160;
  for (const s of city.solids) {
    for (let gx = Math.floor(s.x / B); gx <= Math.floor((s.x + s.w) / B); gx += 1) {
      for (let gy = Math.floor(s.y / B); gy <= Math.floor((s.y + s.h) / B); gy += 1) {
        const key = gx * 10000 + gy;
        if (!bucket.has(key)) bucket.set(key, []);
        bucket.get(key).push(s);
      }
    }
  }
  city.solidIndex = bucket;
  city.solidIndexCell = B;
}

/** Nearby solids for a circle's bounding box. */
export function solidsNear(city, x, y, r) {
  const B = city.solidIndexCell;
  const out = [];
  for (let gx = Math.floor((x - r) / B); gx <= Math.floor((x + r) / B); gx += 1) {
    for (let gy = Math.floor((y - r) / B); gy <= Math.floor((y + r) / B); gy += 1) {
      const list = city.solidIndex.get(gx * 10000 + gy);
      if (!list) continue;
      for (const s of list) if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** A road point: the nearest street centre, used to place traffic and police. */
export function nearestRoad(x, y) {
  const gx = Math.round(x / CELL) * CELL;
  const gy = Math.round(y / CELL) * CELL;
  const dx = Math.abs(x - gx);
  const dy = Math.abs(y - gy);
  if (dx < dy) return { x: gx, y, axis: 'v' };
  return { x, y: gy, axis: 'h' };
}
