// Maths and geometry helpers, plus the seeded random generator. Pure functions only: no state,
// no canvas, no browser globals. The same seed and the same call order always give the same city,
// the same traffic and the same screenshot.

/** mulberry32: small, fast, deterministic. */
export function createRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const easeOut = (t) => 1 - (1 - t) * (1 - t);
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const TAU = Math.PI * 2;

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}
export function dist2(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDiff(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Turn `from` toward `to` by at most `rate` radians. */
export function turnToward(from, to, rate) {
  const d = angleDiff(from, to);
  if (Math.abs(d) <= rate) return to;
  return from + Math.sign(d) * rate;
}

/** Rotate `from` toward `to` with a smoothing factor (0..1 per second). */
export function dampAngle(from, to, k, dt) {
  return from + angleDiff(from, to) * (1 - Math.exp(-k * dt));
}

export function damp(from, to, k, dt) {
  return from + (to - from) * (1 - Math.exp(-k * dt));
}

/** Deterministic value in [lo, hi). */
export const rand = (rng, lo, hi) => lo + rng() * (hi - lo);
export const randInt = (rng, lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
export const pick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/** True when point (px,py) lies inside the axis-aligned rect. */
export function pointInRect(px, py, x, y, w, h) {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

/** True when a circle overlaps an axis-aligned rect. */
export function circleRect(cx, cy, r, x, y, w, h) {
  const nx = clamp(cx, x, x + w);
  const ny = clamp(cy, y, y + h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/**
 * Push a circle out of a rect along the shallowest axis. Returns the corrected {x,y} and whether
 * anything moved. Used by both the walker and the car so walls feel the same either way.
 */
export function resolveCircleRect(cx, cy, r, x, y, w, h) {
  const nx = clamp(cx, x, x + w);
  const ny = clamp(cy, y, y + h);
  let dx = cx - nx;
  let dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 0.0001) {
    const d = Math.sqrt(d2);
    const push = r - d;
    return { x: cx + (dx / d) * push, y: cy + (dy / d) * push, nx: dx / d, ny: dy / d };
  }
  // Centre is inside the rect: leave by the nearest edge.
  const left = cx - x;
  const right = x + w - cx;
  const top = cy - y;
  const bottom = y + h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: x - r, y: cy, nx: -1, ny: 0 };
  if (m === right) return { x: x + w + r, y: cy, nx: 1, ny: 0 };
  if (m === top) return { x: cx, y: y - r, nx: 0, ny: -1 };
  return { x: cx, y: y + h + r, nx: 0, ny: 1 };
}

/** Cheap string hash, used to vary colours from a name. */
export function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Formats money as $1,250. */
export function money(value) {
  const n = Math.max(0, Math.round(value));
  return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Mix two hex colours. */
export function mixHex(a, b, t) {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/** rgba() from a hex colour and an alpha. */
export function alpha(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Bullet/vehicle friendly rounding. */
export const round1 = (v) => Math.round(v * 10) / 10;
