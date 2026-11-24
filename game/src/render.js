// Drawing only: world state in, pixels out. The city is an oblique projection — the ground plane
// is squashed by YSQ and every solid has a height that lifts its top face up and slightly left,
// which is what gives the boxes their lean. Everything on the ground (cars, people, skid marks)
// is squashed and rotated into that plane; everything with a height is drawn as an extruded volume.
//
// Sorted drawables share one list keyed by their front edge, so a car north of a tower is drawn
// first and then covered by the tower. Buildings are pre-rendered once into offscreen canvases
// (facades, lit windows, roof gear, neon) and blitted afterwards; that keeps a 300-building city
// at 60 fps and makes the look consistent between frames.
import { FONT, MONO, PALETTE, VIEW, YSQ } from './config.js';
import { alpha, clamp, createRandom, dist, mixHex, TAU } from './util.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_OVER = 'over';

/** Screen-space height vector per world unit of elevation. */
export const HX = 0.33;
export const HY = 0.72;
/** Sprite supersample: sprites are drawn at this scale then blitted down/up by zoom. */
const SS = 1.25;

// Characters are authored on a small collision radius so pathing and crowd behaviour stay sane,
// but a person is drawn at 2.2x that so the silhouette reads at 40% of a car's length instead of
// looking like a coin. This is a drawing-only constant; physics is untouched.
const PED_SCALE = 2.2;

const srgb = (hex, a) => alpha(hex, a);

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const view = { scale: 1, x: 0, y: 0, dpr: 1 };
  const sprites = new WeakMap();
  const fontCache = new Map();

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    canvas.width = w;
    canvas.height = h;
    view.dpr = dpr;
    // The logical width is fixed at 1280; the logical height follows the window's aspect so the
    // canvas is always full-bleed. A height outside the plausible range is clamped, which is the
    // only case that letterboxes (an extremely wide or tall window).
    const logical = Math.round((VIEW.width * h) / w);
    VIEW.height = clamp(logical, 560, 1000);
    view.scale = Math.min(w / VIEW.width, h / VIEW.height);
    view.x = (w - VIEW.width * view.scale) / 2;
    view.y = (h - VIEW.height * view.scale) / 2;
  }

  function font(size, weight = 600, mono = false) {
    const key = size + weight + mono;
    if (!fontCache.has(key)) fontCache.set(key, `${weight} ${size}px ${mono ? MONO : FONT}`);
    return fontCache.get(key);
  }

  function text(value, x, y, size, colour, align = 'left', baseline = 'alphabetic', weight = 600, mono = false) {
    ctx.font = font(size, weight, mono);
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(value, x, y);
  }

  /* ---------------------------------------------------------------- projection */

  const project = { x: 0, y: 0, sx: 0, sy: 0 };

  function toScreen(x, y, cam, shakeX = 0, shakeY = 0) {
    project.x = (x - cam.x) * cam.zoom + VIEW.width / 2 + shakeX;
    project.y = (y - cam.y) * cam.zoom * YSQ + VIEW.height / 2 + shakeY;
    return project;
  }

  /** Screen pixels back to a ground-plane world point (mouse aiming). */
  function toWorld(sx, sy, cam) {
    return {
      x: (sx - VIEW.width / 2) / cam.zoom + cam.x,
      y: (sy - VIEW.height / 2) / (cam.zoom * YSQ) + cam.y,
    };
  }

  /* ---------------------------------------------------------------- building sprites */

  function spriteFor(b) {
    let s = sprites.get(b);
    if (s) return s;
    const rng = createRandom(b.seed);
    const w = b.w;
    const hb = b.h * YSQ;
    const H = b.height;
    const dx = -HX * H;
    const dy = -HY * H;
    const pad = 16;
    const left = Math.min(0, dx) - pad;
    const right = Math.max(w, w + dx) + pad;
    const top = Math.min(0, dy) - pad;
    const bottom = Math.max(hb, hb + dy) + pad;
    const cw = Math.ceil((right - left) * SS);
    const ch = Math.ceil((bottom - top) * SS);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d');
    g.setTransform(SS, 0, 0, SS, -left * SS, -top * SS);

    // Ground contact shadow, thrown away from the street light.
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.ellipse(w / 2 + 8, hb / 2 + 10, w * 0.62, hb * 0.66, 0, 0, TAU);
    g.fill();

    // East wall (the face pointing away from the camera's lean) — darker.
    g.beginPath();
    g.moveTo(w, 0);
    g.lineTo(w + dx, dy);
    g.lineTo(w + dx, hb + dy);
    g.lineTo(w, hb);
    g.closePath();
    const ew = g.createLinearGradient(w, 0, w + dx, 0);
    ew.addColorStop(0, b.wall);
    ew.addColorStop(1, mixHex(b.wall, '#000000', 0.55));
    g.fillStyle = ew;
    g.fill();

    // South facade: lit from the street at the bottom, fading up into the night.
    g.beginPath();
    g.moveTo(0, hb);
    g.lineTo(dx, hb + dy);
    g.lineTo(w + dx, hb + dy);
    g.lineTo(w, hb);
    g.closePath();
    const fg = g.createLinearGradient(0, hb, 0, hb + dy);
    fg.addColorStop(0, mixHex(b.wall, b.neon ?? PALETTE.neonCyan, 0.14));
    fg.addColorStop(0.55, b.wall);
    fg.addColorStop(1, mixHex(b.wall, '#05060b', 0.45));
    g.fillStyle = fg;
    g.fill();

    // Facade windows: a grid on the parallelogram, some lit. Clipped to the face so a window can
    // never bleed off the silhouette into the sky.
    g.save();
    g.beginPath();
    g.moveTo(0, hb);
    g.lineTo(dx, hb + dy);
    g.lineTo(w + dx, hb + dy);
    g.lineTo(w, hb);
    g.closePath();
    g.clip();
    const rows = Math.max(2, Math.floor(H / 26));
    const cols = Math.max(2, Math.floor(w / 26));
    const sx = w / cols;
    const syf = -dy / rows;
    for (let r = 0; r < rows; r += 1) {
      const f = (r + 0.5) / rows;
      const yy = hb + dy * f;
      const xoff = dx * f;
      for (let cI = 0; cI < cols; cI += 1) {
        const lit = rng();
        const xx = xoff + sx * (cI + 0.5) - sx * 0.22;
        const h = Math.min(syf * 0.52, 7.5);
        const wW = Math.min(sx * 0.46, 9);
        if (lit < 0.44) {
          const warm = rng() < 0.62;
          g.fillStyle = warm ? (rng() < 0.5 ? '#ffd79a' : '#ffc164') : '#9ff0ff';
          g.globalAlpha = 0.6 + rng() * 0.4;
        } else {
          g.fillStyle = '#0b0e18';
          g.globalAlpha = 0.8;
        }
        g.fillRect(xx, yy + 5, wW, h);
        g.globalAlpha = 1;
      }
    }
    g.restore();

    // Ground-floor shopfront: a lit band of shop windows that spills colour onto the pavement.
    const bandH = Math.min(18, -dy * 0.14);
    const shopC = b.neon || '#ffcf87';
    const bg2 = g.createLinearGradient(0, hb - bandH, 0, hb);
    bg2.addColorStop(0, srgb(shopC, 0.08));
    bg2.addColorStop(0.55, srgb(shopC, 0.3));
    bg2.addColorStop(1, srgb(shopC, 0.62));
    g.fillStyle = bg2;
    g.beginPath();
    g.moveTo(0, hb - bandH);
    g.lineTo(dx * 0.12, hb + dy * 0.12 - bandH);
    g.lineTo(w + dx * 0.12, hb + dy * 0.12 - bandH);
    g.lineTo(w, hb - bandH);
    g.closePath();
    g.fill();
    // Mullions in the shopfront glass.
    g.strokeStyle = 'rgba(6,8,14,0.55)';
    g.lineWidth = 1.4;
    for (let m = 1; m < Math.max(3, Math.floor(w / 26)); m += 1) {
      const mx = (w / Math.max(3, Math.floor(w / 26))) * m;
      g.beginPath();
      g.moveTo(mx, hb - bandH);
      g.lineTo(mx + dx * 0.12, hb + dy * 0.12 - bandH);
      g.lineTo(mx + dx * 0.12, hb + dy * 0.12);
      g.lineTo(mx, hb);
      g.stroke();
    }

    // A vertical neon strip up the east corner: the signature of the city's taller blocks.
    if (b.neon && H > 90) {
      g.save();
      g.shadowColor = b.neon;
      g.shadowBlur = 10;
      g.strokeStyle = srgb(b.neon, 0.75);
      g.lineWidth = 1.8;
      g.beginPath();
      g.moveTo(w - 2, hb - 4);
      g.lineTo(w + dx + 2, hb + dy + 4);
      g.stroke();
      g.restore();
    }

    // Roof: flat slab, a lighter top edge, and mechanical clutter.
    g.beginPath();
    g.moveTo(dx, dy);
    g.lineTo(w + dx, dy);
    g.lineTo(w + dx, hb + dy);
    g.lineTo(dx, hb + dy);
    g.closePath();
    g.fillStyle = b.roof;
    g.fill();
    g.strokeStyle = srgb(mixHex(b.roof, '#ffffff', 0.22), 0.5);
    g.lineWidth = 1.2;
    g.stroke();

    // Roof edge highlight in the building's neon, if it has one.
    if (b.neon) {
      g.save();
      g.shadowColor = b.neon;
      g.shadowBlur = 12;
      g.strokeStyle = srgb(b.neon, 0.7);
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(dx, dy + 1);
      g.lineTo(w + dx, dy + 1);
      g.stroke();
      g.restore();
    }

    if (b.hasRoofProp) {
      // A real cluster of rooftop clutter, so the roof is not a dead slab: an AC unit, its vent
      // fans, a stair-head hut, pipe runs, a water tank, and a scatter of small boxes.
      const bx = dx + w * 0.14;
      const by = dy + hb * 0.30;
      const bw = w * 0.30;
      const bh2 = hb * 0.24;
      // Cast shadow of the cluster.
      g.fillStyle = 'rgba(0,0,0,0.42)';
      g.fillRect(bx + 4, by + 5, bw, bh2);
      // AC housing, slightly lighter on the top edge so it reads as a volume.
      g.fillStyle = mixHex(b.roof, '#000000', 0.22);
      g.fillRect(bx, by, bw, bh2);
      g.fillStyle = srgb(mixHex(b.roof, '#ffffff', 0.22), 0.6);
      g.fillRect(bx, by, bw, 2.5);
      // Twin vent fans.
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 1;
      for (let fN = 0; fN < 2; fN += 1) {
        const fx = bx + bw * (0.3 + fN * 0.4);
        const fy = by + bh2 * 0.5;
        g.beginPath();
        g.arc(fx, fy, Math.min(bh2 * 0.32, 4.5), 0, TAU);
        g.stroke();
        g.beginPath();
        g.arc(fx, fy, Math.min(bh2 * 0.15, 2.1), 0, TAU);
        g.stroke();
      }
      // A stair-head hut with a lit doorway.
      const hx = dx + w * 0.60;
      const hy = dy + hb * 0.52;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(hx + 3, hy + 4, w * 0.20, hb * 0.26);
      g.fillStyle = mixHex(b.roof, b.neon ?? '#ffffff', 0.10);
      g.fillRect(hx, hy, w * 0.20, hb * 0.26);
      g.fillStyle = srgb(mixHex(b.roof, '#ffffff', 0.2), 0.55);
      g.fillRect(hx, hy, w * 0.20, 2);
      g.fillStyle = 'rgba(255,214,150,0.85)';
      g.fillRect(hx + w * 0.055, hy + hb * 0.13, w * 0.055, hb * 0.11);
      // Water tank on the big ones.
      if (b.height > 70) {
        const tx = dx + w * 0.42;
        const ty = dy + hb * 0.68;
        const tr = Math.min(9, w * 0.10);
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.beginPath();
        g.ellipse(tx + 3, ty + 4, tr, tr * 0.9, 0, 0, TAU);
        g.fill();
        const tg = g.createRadialGradient(tx - tr * 0.4, ty - tr * 0.4, 0, tx, ty, tr);
        tg.addColorStop(0, mixHex(b.roof, '#ffffff', 0.22));
        tg.addColorStop(1, mixHex(b.roof, '#000000', 0.4));
        g.fillStyle = tg;
        g.beginPath();
        g.arc(tx, ty, tr, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        g.lineWidth = 1;
        g.stroke();
      }
      // Pipe runs and a few small crates.
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(dx + w * 0.08, dy + hb * 0.78);
      g.lineTo(dx + w * 0.88, dy + hb * 0.72);
      g.stroke();
      for (let k = 0; k < 4; k += 1) {
        const cxp2 = dx + w * (0.1 + ((k * 37) % 80) / 100);
        const cyp2 = dy + hb * (0.12 + ((k * 53) % 70) / 100);
        const s = 2.4 + (k % 3) * 1.3;
        g.fillStyle = `rgba(0,0,0,${0.3 + (k % 2) * 0.12})`;
        g.fillRect(cxp2, cyp2, s, s);
      }
    }

    // Antenna on the tall towers, with a red aviation lamp.
    if (b.antenna) {
      g.strokeStyle = 'rgba(140,160,200,0.5)';
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(dx + w * 0.3, dy + hb * 0.5);
      g.lineTo(dx + w * 0.3, dy - 22);
      g.stroke();
      g.save();
      g.shadowColor = '#ff3d4d';
      g.shadowBlur = 8;
      g.fillStyle = '#ff6b74';
      g.beginPath();
      g.arc(dx + w * 0.3, dy - 22, 1.8, 0, TAU);
      g.fill();
      g.restore();
    }

    // The shop sign, mounted on the facade above the street: the main neon of the city.
    if (b.neon && b.sign) {
      const size = clamp(w * 0.15, 7, 13);
      const ty = hb + dy * 0.22 - 3;
      const tx = dx * 0.22 + w / 2;
      g.save();
      g.font = font(size, 800);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = b.neon;
      g.shadowBlur = 16;
      g.fillStyle = srgb(b.neon, 0.92);
      g.fillText(b.sign, tx, ty);
      g.shadowBlur = 4;
      g.fillStyle = '#fdf7ff';
      g.globalAlpha = 0.9;
      g.fillText(b.sign, tx, ty);
      g.restore();
      // A sign board behind it.
      g.fillStyle = 'rgba(4,5,10,0.55)';
    }

    s = { canvas: c, ox: left, oy: top, w: cw / SS, h: ch / SS };
    sprites.set(b, s);
    return s;
  }

  /* ---------------------------------------------------------------- ground */

  function drawGround(state, cam, sh) {
    const { city } = state;
    const z = cam.zoom;
    const halfW = VIEW.width / 2 / z + 80;
    const halfH = VIEW.height / 2 / (z * YSQ) + 90;

    // Backdrop: night sky bleeding into fog at the top of the frame.
    const bg = ctx.createLinearGradient(0, 0, 0, VIEW.height);
    bg.addColorStop(0, '#0b0818');
    bg.addColorStop(0.42, PALETTE.fogFar);
    bg.addColorStop(1, '#0e0b1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);

    // Wet asphalt over the whole visible ground.
    const p0 = toScreen(cam.x - halfW, cam.y - halfH, cam, sh.x, sh.y);
    ctx.fillStyle = PALETTE.asphalt;
    ctx.fillRect(p0.x, p0.y, halfW * 2 * z, halfH * 2 * z * YSQ);

    // Wet sheen: bright bands of reflected sky across the road, so the asphalt is not a flat slab.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i += 1) {
      const ry = cam.y - halfH + ((i * 421 + state.clock * 6) % (halfH * 2));
      const pp = toScreen(cam.x, ry, cam, sh.x, sh.y);
      const g = ctx.createLinearGradient(0, pp.y, 0, pp.y + 90 * z * YSQ);
      g.addColorStop(0, 'rgba(80,110,190,0.13)');
      g.addColorStop(1, 'rgba(60,90,170,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p0.x, pp.y, halfW * 2 * z, 90 * z * YSQ);
    }
    for (let i = 0; i < 7; i += 1) {
      const ang = (i / 7) * TAU + state.clock * 0.02;
      const rx = cam.x + Math.cos(ang) * 620;
      const ry = cam.y + Math.sin(ang) * 620;
      const pp = toScreen(rx, ry, cam, sh.x, sh.y);
      const grad = ctx.createRadialGradient(pp.x, pp.y, 0, pp.x, pp.y, 400 * z);
      grad.addColorStop(0, 'rgba(110,70,190,0.10)');
      grad.addColorStop(1, 'rgba(110,70,190,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(pp.x - 420 * z, pp.y - 320 * z, 840 * z, 640 * z);
    }
    ctx.restore();

    // Blocks: sidewalk ring, then the lot, with the kerb catching light.
    for (let i = 0; i < city.blocks.length; i += 1) {
      const b = city.blocks[i];
      const a = toScreen(b.x, b.y, cam, sh.x, sh.y);
      const w = b.w * z;
      const h = b.h * z * YSQ;
      if (a.x > VIEW.width + 40 || a.x + w < -40 || a.y > VIEW.height + 40 || a.y + h < -40) continue;

      if (b.park) {
        // A paved square: warm terracotta flagstones, deliberately nothing like the cold asphalt
        // outside the kerb, so the market reads as a place rather than a tinted patch of road.
        ctx.fillStyle = '#3b2f36';
        ctx.fillRect(a.x, a.y, w, h);
        // Flagstone courses, offset each row so it reads as paving rather than stripes.
        const rows = 12;
        for (let s = 0; s < rows; s += 1) {
          const ry = a.y + (s / rows) * h;
          ctx.fillStyle = s % 2 ? 'rgba(255,222,186,0.075)' : 'rgba(255,196,150,0.035)';
          ctx.fillRect(a.x + (s % 2 ? 7 : 0) * z, ry, w, Math.max(1, (h / rows) * 0.46));
        }
        // Dark grout lines between courses.
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.lineWidth = 1;
        for (let s = 1; s < rows; s += 1) {
          const ry = a.y + (s / rows) * h;
          ctx.beginPath(); ctx.moveTo(a.x, ry); ctx.lineTo(a.x + w, ry); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,206,160,0.30)';
        ctx.lineWidth = 2;
        ctx.strokeRect(a.x, a.y, w, h);

        // Stalls ringing the fountain: each one is a counter with four posts holding a striped
        // canopy above it. Height is what separates a stall from a painted rectangle.
        if (b.stalls) {
          for (let s = 0; s < b.stalls.length; s += 1) {
            const st = b.stalls[s];
            const p = toScreen(st.x, st.y, cam, sh.x, sh.y);
            const sw = st.w * z;
            const shh = st.h * z * YSQ;
            const LIFT = 15 * z * YSQ;   // how far the canopy floats above the counter
            ctx.save();
            ctx.translate(p.x, p.y);
            // No rotation: in an oblique projection vertical is always screen-up, so a rotated
            // canopy would float sideways instead of overhead.
            // Cast shadow on the paving.
            ctx.fillStyle = 'rgba(0,0,0,0.46)';
            ctx.beginPath();
            ctx.ellipse(4 * z, 5 * z, sw * 0.62, shh * 0.72, 0, 0, TAU);
            ctx.fill();
            // Four corner posts.
            ctx.fillStyle = '#16131c';
            const px2 = sw * 0.42;
            const py2 = shh * 0.42;
            ctx.fillRect(-px2 - 1, -py2 - LIFT, 2.2 * z, LIFT);
            ctx.fillRect(px2 - 1.2, -py2 - LIFT, 2.2 * z, LIFT);
            ctx.fillRect(-px2 - 1, py2 - LIFT, 2.2 * z, LIFT);
            ctx.fillRect(px2 - 1.2, py2 - LIFT, 2.2 * z, LIFT);
            // Counter body: a slab with a lit front edge, at ground level.
            ctx.fillStyle = '#241d2c';
            ctx.fillRect(-sw * 0.5, -shh * 0.5, sw, shh);
            ctx.fillStyle = '#332a3e';
            ctx.fillRect(-sw * 0.5, shh * 0.5 - 3 * z, sw, 3 * z);
            // Goods heaped on the counter: small bright produce, so it reads as a market.
            for (let g = 0; g < 5; g += 1) {
              ctx.fillStyle = g % 2 ? srgb(st.awning, 0.92) : '#e8c98a';
              const gx = (-0.34 + g * 0.17) * sw;
              ctx.beginPath();
              ctx.arc(gx, -shh * 0.14 + Math.sin(g * 2.1) * 2, 2.1 * z, 0, TAU);
              ctx.fill();
            }
            // Canopy: striped, floating on the posts, catching the lamp light.
            const cw = sw * 1.14;
            const chh = shh * 1.14;
            for (let k = 0; k < 6; k += 1) {
              ctx.fillStyle = k % 2 ? srgb(st.awning, 0.95) : srgb(st.awning, 0.30);
              ctx.fillRect(-cw * 0.5 + (k / 6) * cw, -chh * 0.5 - LIFT, cw / 6, chh);
            }
            ctx.strokeStyle = srgb(st.awning, 0.55);
            ctx.lineWidth = 1.2;
            ctx.strokeRect(-cw * 0.5, -chh * 0.5 - LIFT, cw, chh);
            // Scalloped valance along the canopy's front edge.
            ctx.fillStyle = srgb(st.awning, 0.72);
            for (let k = 0; k < 6; k += 1) {
              ctx.fillRect(-cw * 0.5 + (k / 6) * cw, chh * 0.5 - LIFT, cw / 6, 2.4 * z);
            }
            ctx.restore();
            // Warm bulb under the canopy.
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const g2 = ctx.createRadialGradient(p.x, p.y - LIFT, 0, p.x, p.y - LIFT, 34 * z);
            g2.addColorStop(0, srgb(st.awning, 0.26));
            g2.addColorStop(0.5, srgb(st.awning, 0.10));
            g2.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g2;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, 34 * z, 30 * z * YSQ, 0, 0, TAU);
            ctx.fill();
            ctx.restore();
          }
        }

        // The fountain: a bright ring of water in the middle of the square.
        if (b.fountain) {
          const f = toScreen(b.fountain.x, b.fountain.y, cam, sh.x, sh.y);
          ctx.save();
          ctx.shadowColor = PALETTE.neonCyan;
          ctx.shadowBlur = 16;
          ctx.fillStyle = PALETTE.water;
          ctx.beginPath();
          ctx.ellipse(f.x, f.y, b.fountain.r * z, b.fountain.r * z * YSQ, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = srgb(PALETTE.waterLit, 0.95);
          ctx.beginPath();
          ctx.ellipse(f.x, f.y, b.fountain.r * 0.62 * z, b.fountain.r * 0.62 * z * YSQ, 0, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = srgb(PALETTE.neonCyan, 0.62);
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.restore();
        }
        continue;
      }

      // Sidewalk.
      ctx.fillStyle = PALETTE.sidewalk;
      ctx.fillRect(a.x, a.y, w, h);
      // Kerb line on the south and east edges.
      ctx.fillStyle = PALETTE.curb;
      ctx.fillRect(a.x, a.y + h - 2, w, 2);
      ctx.fillRect(a.x + w - 2, a.y, 2, h);
      // Paving grout: a faint 1px grid, cheap and it sells the scale.
      ctx.strokeStyle = 'rgba(0,0,0,0.20)';
      ctx.lineWidth = 1;
      for (let t = 22; t < b.w; t += 26) {
        const gx = a.x + t * z;
        ctx.beginPath(); ctx.moveTo(gx, a.y); ctx.lineTo(gx, a.y + h); ctx.stroke();
        const gy = a.y + t * z * YSQ;
        ctx.beginPath(); ctx.moveTo(a.x, gy); ctx.lineTo(a.x + w, gy); ctx.stroke();
      }
      // The lot itself.
      ctx.fillStyle = '#221f2e';
      const inset = 22 * z;
      ctx.fillRect(a.x + inset, a.y + inset * YSQ, w - inset * 2, h - inset * 2 * YSQ);
    }

    // Water on the east edge.
    const wtr = city.water;
    const wa = toScreen(wtr.x, wtr.y, cam, sh.x, sh.y);
    const ww = wtr.w * z;
    const wh = wtr.h * z * YSQ;
    if (wa.x < VIEW.width && wa.x + ww > 0) {
      const wg = ctx.createLinearGradient(wa.x, 0, wa.x + 260 * z, 0);
      wg.addColorStop(0, PALETTE.waterLit);
      wg.addColorStop(1, PALETTE.water);
      ctx.fillStyle = wg;
      ctx.fillRect(wa.x, wa.y, ww, wh);
      // Neon reflections broken into horizontal ribbons.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i += 1) {
        const ry = wa.y + ((i * 137.5) % wh);
        const rw = (60 + ((i * 71) % 220)) * z;
        ctx.fillStyle = srgb(i % 3 === 0 ? PALETTE.neonMagenta : i % 3 === 1 ? PALETTE.neonCyan : PALETTE.neonAmber, 0.06 + (i % 4) * 0.016);
        ctx.fillRect(wa.x + 30 * z + ((i * 53) % 120) * z, ry, rw, 2.5 * z);
      }
      ctx.restore();
      // Quay wall.
      ctx.fillStyle = '#332c44';
      ctx.fillRect(wa.x - 6 * z, wa.y, 6 * z, wh);
      ctx.fillStyle = srgb(PALETTE.neonCyan, 0.45);
      ctx.fillRect(wa.x - 6 * z, wa.y, 1.6 * z, wh);
      // Pier.
      const pier = city.pier;
      const pa = toScreen(pier.x, pier.y, cam, sh.x, sh.y);
      ctx.fillStyle = '#38304a';
      ctx.fillRect(pa.x, pa.y, pier.w * z, pier.h * z * YSQ);
      ctx.strokeStyle = 'rgba(255,190,120,0.3)';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(pa.x, pa.y, pier.w * z, pier.h * z * YSQ);
    }

    // Streets: dashes down the middle of every street, crosswalks at every junction.
    ctx.fillStyle = srgb(PALETTE.lane, 0.42);
    const dash = 16;
    const gap = 22;
    for (let i = 0; i <= city.grid; i += 1) {
      const line = i * city.cell;
      // Vertical streets.
      let a = toScreen(line, 0, cam, sh.x, sh.y);
      if (a.x > -30 && a.x < VIEW.width + 30) {
        for (let y = 0; y < city.size; y += dash + gap) {
          const q = toScreen(line, y, cam, sh.x, sh.y);
          ctx.fillRect(q.x - 1.4 * z, q.y, 2.8 * z, dash * z * YSQ);
        }
      }
      // Horizontal streets.
      a = toScreen(0, line, cam, sh.x, sh.y);
      if (a.y > -30 && a.y < VIEW.height + 30) {
        for (let x = 0; x < city.size; x += dash + gap) {
          const q = toScreen(x, line, cam, sh.x, sh.y);
          ctx.fillRect(q.x, q.y - 1.2 * z, dash * z, 2.4 * z * YSQ);
        }
      }
    }

    // Crosswalks: six white bars on each approach to an intersection.
    ctx.fillStyle = 'rgba(230,235,255,0.26)';
    const half = city.road / 2;
    for (let j = 0; j <= city.grid; j += 1) {
      for (let i = 0; i <= city.grid; i += 1) {
        const cx = i * city.cell;
        const cy = j * city.cell;
        const cc = toScreen(cx, cy, cam, sh.x, sh.y);
        if (cc.x < -60 || cc.x > VIEW.width + 60 || cc.y < -60 || cc.y > VIEW.height + 60) continue;
        for (let k = 0; k < 5; k += 1) {
          const off = -half + 8 + k * 13;
          ctx.fillRect(cc.x + off * z, cc.y - half * z * YSQ - 12 * z * YSQ, 7 * z, 12 * z * YSQ);
          ctx.fillRect(cc.x + off * z, cc.y + half * z * YSQ, 7 * z, 12 * z * YSQ);
          ctx.fillRect(cc.x - half * z - 12 * z, cc.y + off * z * YSQ, 12 * z, 7 * z * YSQ);
          ctx.fillRect(cc.x + half * z, cc.y + off * z * YSQ, 12 * z, 7 * z * YSQ);
        }
      }
    }
  }

  /** Street furniture with height: lamp posts with lit heads, trees inside the park. */
  function drawProps(state, cam, sh) {
    const { city } = state;
    const z = cam.zoom;
    const LAMP_H = 46;
    for (let i = 0; i < city.lights.length; i += 1) {
      const l = city.lights[i];
      const p = toScreen(l.x, l.y, cam, sh.x, sh.y);
      if (p.x < -40 || p.x > VIEW.width + 40 || p.y < -60 || p.y > VIEW.height + 60) continue;
      // Post: a thin vertical, leaning with the projection.
      const topX = p.x - HX * LAMP_H * z;
      const topY = p.y - HY * LAMP_H * z;
      ctx.strokeStyle = 'rgba(120,128,160,0.55)';
      ctx.lineWidth = Math.max(1, 1.6 * z);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(topX, topY);
      ctx.stroke();
      // The lamp head, blooming.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(topX, topY, 0, topX, topY, 22 * z);
      g.addColorStop(0, 'rgba(255,228,170,0.85)');
      g.addColorStop(0.35, 'rgba(255,200,120,0.28)');
      g.addColorStop(1, 'rgba(255,180,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(topX, topY, 22 * z, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,246,220,0.95)';
      ctx.beginPath();
      ctx.arc(topX, topY, 2.6 * z, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // Trees: trunk + a soft canopy disc, drawn slightly transparent so they read as foliage.
    for (let i = 0; i < city.trees.length; i += 1) {
      const t = city.trees[i];
      const p = toScreen(t.x, t.y, cam, sh.x, sh.y);
      if (p.x < -60 || p.x > VIEW.width + 60 || p.y < -80 || p.y > VIEW.height + 60) continue;
      const trunkH = 22 * z;
      ctx.strokeStyle = 'rgba(50,40,38,0.8)';
      ctx.lineWidth = 2.2 * z;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - HX * trunkH, p.y - HY * trunkH);
      ctx.stroke();
      const cxp = p.x - HX * trunkH * 1.5;
      const cyp = p.y - HY * trunkH * 1.6;
      const r = t.r * z * 1.5;
      const g2 = ctx.createRadialGradient(cxp - r * 0.3, cyp - r * 0.3, 0, cxp, cyp, r);
      g2.addColorStop(0, 'rgba(70,150,105,0.95)');
      g2.addColorStop(0.6, 'rgba(36,90,66,0.92)');
      g2.addColorStop(1, 'rgba(18,48,36,0.55)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, r, r * 0.86, 0, 0, TAU);
      ctx.fill();
    }
  }

  /* ---------------------------------------------------------------- ground decals */

  function drawPools(state, cam, sh) {
    const { city } = state;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < city.lights.length; i += 1) {
      const l = city.lights[i];
      const p = toScreen(l.x, l.y, cam, sh.x, sh.y);
      if (p.x < -120 || p.x > VIEW.width + 120 || p.y < -120 || p.y > VIEW.height + 120) continue;
      const r = 130 * cam.zoom;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(255,222,168,0.32)');
      g.addColorStop(0.35, 'rgba(255,196,126,0.14)');
      g.addColorStop(0.72, 'rgba(255,176,104,0.04)');
      g.addColorStop(1, 'rgba(255,170,100,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * YSQ, 0, 0, TAU);
      ctx.fill();
    }
    // Neon spill from shop signs onto the pavement.
    for (let i = 0; i < city.signs.length; i += 1) {
      const s = city.signs[i];
      const p = toScreen(s.x, s.y + 12, cam, sh.x, sh.y);
      if (p.x < -100 || p.x > VIEW.width + 100 || p.y < -60 || p.y > VIEW.height + 60) continue;
      const r = 84 * cam.zoom;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, srgb(s.color, 0.32));
      g.addColorStop(0.4, srgb(s.color, 0.12));
      g.addColorStop(1, srgb(s.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * YSQ, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSkids(state, cam, sh) {
    const skids = state.skids;
    for (let i = 0; i < skids.length; i += 1) {
      const s = skids[i];
      if (s.life <= 0) continue;
      const p = toScreen(s.x, s.y, cam, sh.x, sh.y);
      if (p.x < -30 || p.x > VIEW.width + 30 || p.y < -30 || p.y > VIEW.height + 30) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(cam.zoom, cam.zoom * YSQ);
      ctx.rotate(s.angle);
      ctx.fillStyle = `rgba(6,5,10,${(s.alpha * Math.min(1, s.life / 4)).toFixed(3)})`;
      ctx.fillRect(-5, -1.6, 10, 3.2);
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- entities */

  function drawPed(ped, cam, sh, state) {
    const p = toScreen(ped.x, ped.y, cam, sh.x, sh.y);
    if (p.x < -40 || p.x > VIEW.width + 40 || p.y < -40 || p.y > VIEW.height + 40) return;
    const z = cam.zoom;
    const t = state.clock;
    ctx.save();
    ctx.translate(p.x, p.y);
    // A person reads at 40% of a car's length. Collision radius stays small so paths and crowds
    // still work, so the silhouette is drawn up from the physical radius.
    ctx.scale(z * PED_SCALE, z * YSQ * PED_SCALE);
    // Shadow, offset one consistent direction (down-right) so body and shadow never read as two
    // stones of equal weight.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(3.2, 3.6, 5.4, 2.6, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(ped.angle);
    const bob = ped.dead ? 0 : Math.sin(ped.phase) * 0.8;
    if (ped.dead) {
      ctx.fillStyle = mixHex(ped.colour, '#000000', 0.4);
      ctx.beginPath();
      ctx.ellipse(0, 0, 8.5, 4.4, 0, 0, TAU);
      ctx.fill();
      // A small pool.
      ctx.fillStyle = 'rgba(90,10,26,0.5)';
      ctx.beginPath();
      ctx.ellipse(-3, 1.5, 6.5, 3.6, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }
    // Top-down human silhouette: shoulders a clear capsule across the walking axis, swinging
    // legs that break the outline, and a head disc smaller than the shoulder width. Those three
    // cues together are what make a figure read as a person from directly above.
    const swing = Math.sin(ped.phase) * 1.5;
    // Legs: two short bars behind the torso, swinging out of phase.
    ctx.fillStyle = mixHex(ped.colour, '#000000', 0.55);
    ctx.fillRect(-2.1, -3.9 + swing * 0.5, 2.6, 4.2);
    ctx.fillRect(-2.1, 0.1 - swing * 0.5, 2.6, 4.2);
    // Torso: a capsule wider across the shoulders than deep, so the axis of travel is legible.
    const body = ctx.createLinearGradient(-3, -4.4, 3, 4.4);
    body.addColorStop(0, mixHex(ped.colour, '#ffffff', 0.18));
    body.addColorStop(1, mixHex(ped.colour, '#000000', 0.34));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(-0.4, 0, 4.3, 4.9, 0, 0, TAU);
    ctx.fill();
    // Shoulder line: a lighter rim across the leading edge.
    ctx.strokeStyle = mixHex(ped.colour, '#ffffff', 0.34);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.ellipse(-0.4, 0, 4.3, 4.9, 0, -1.9, 1.9);
    ctx.stroke();
    // Arms.
    ctx.fillStyle = mixHex(ped.colour, '#000000', 0.2);
    ctx.fillRect(-0.9, -5.1 + bob * 0.3, 2.4, 1.5);
    ctx.fillRect(-0.9, 3.6 - bob * 0.3, 2.4, 1.5);
    // Head: plainly forward of the shoulders and smaller than them.
    ctx.fillStyle = ped.skin;
    ctx.beginPath();
    ctx.arc(1.5, 0, 2.7, 0, TAU);
    ctx.fill();
    if (ped.hat) {
      ctx.fillStyle = '#16141d';
      ctx.beginPath();
      ctx.arc(1.5, 0, 3.0, 0, TAU);
      ctx.fill();
      // A brim, so a hat is a hat and not just a bigger head.
      ctx.fillRect(2.6, -2.4, 1.8, 4.8);
    }
    if (ped.armed && !ped.dead) {
      ctx.fillStyle = '#0c0d14';
      ctx.fillRect(1.6, -4.4, 6.4, 1.9);
      ctx.fillStyle = '#20222c';
      ctx.fillRect(2.2, -3.9, 2.2, 1.0);
    }
    if (ped.hurt > 0.3) {
      ctx.fillStyle = `rgba(255,45,70,${ped.hurt * 0.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // Panic mark: a tiny exclamation over a fleeing civilian.
    if (ped.panicked > 0 && Math.sin(t * 14 + ped.phase) > 0.3) {
      text('!', p.x, p.y - 16 * z, 13, '#ffd166', 'center', 'middle', 800);
    }
    if (ped.boss) {
      ctx.save();
      ctx.shadowColor = PALETTE.neonMagenta;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = srgb(PALETTE.neonMagenta, 0.9);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y - 4, 13 * z, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawCar(car, cam, sh, state) {
    const p = toScreen(car.x, car.y, cam, sh.x, sh.y);
    const z = cam.zoom;
    const size = Math.max(car.spec.len, car.spec.wid);
    if (p.x < -size * z * 2 || p.x > VIEW.width + size * z * 2 || p.y < -size * z * 2 || p.y > VIEW.height + size * z * 2) return;
    const L = car.spec.len;
    const W = car.spec.wid;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(z, z * YSQ);
    // Ground shadow + headlight wash before the body, all in the ground plane.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(2, 3, L * 0.58, W * 0.66, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(car.angle);

    if (!car.wrecked) {
      // Headlights: two long cones, additive.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createLinearGradient(0, 0, L * 2.4, 0);
      halo.addColorStop(0, 'rgba(255,240,200,0.34)');
      halo.addColorStop(0.35, 'rgba(255,230,180,0.12)');
      halo.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.moveTo(L * 0.46, -W * 0.3);
      ctx.lineTo(L * 2.4, -W * 1.5);
      ctx.lineTo(L * 2.4, W * 1.5);
      ctx.lineTo(L * 0.46, W * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Body.
    const base = car.wrecked ? mixHex(car.color, '#1a1a1a', 0.7) : car.color;
    const grad = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    grad.addColorStop(0, mixHex(base, '#ffffff', 0.22));
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, mixHex(base, '#000000', 0.45));
    ctx.fillStyle = grad;
    roundRect(ctx, -L / 2, -W / 2, L, W, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,6,12,0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Windows and roof.
    ctx.fillStyle = 'rgba(10,16,28,0.92)';
    roundRect(ctx, -L * 0.16, -W * 0.36, L * 0.36, W * 0.72, 3);
    ctx.fill();
    ctx.fillStyle = srgb(mixHex(base, '#ffffff', 0.32), 0.45);
    roundRect(ctx, -L * 0.12, -W * 0.3, L * 0.28, W * 0.6, 2);
    ctx.fill();

    // Lights.
    ctx.save();
    ctx.shadowBlur = 9;
    ctx.shadowColor = '#fff2c8';
    ctx.fillStyle = '#fff8de';
    ctx.fillRect(L * 0.44, -W * 0.4, 3.4, 5);
    ctx.fillRect(L * 0.44, W * 0.4 - 5, 3.4, 5);
    ctx.shadowColor = '#ff2b3d';
    ctx.fillStyle = '#ff5261';
    ctx.fillRect(-L * 0.5, -W * 0.4, 2.8, 4.4);
    ctx.fillRect(-L * 0.5, W * 0.4 - 4.4, 2.8, 4.4);
    ctx.restore();

    // Police livery. A cruiser has to be unmistakable at a glance, so it gets the full treatment:
    // a white body over black doors, a hard dividing band, a roof "POLICE" panel, and a wide
    // light bar that throws a real coloured halo. Small stripes on a dark car vanish at night.
    if (car.police) {
      // Black doors fore and aft, leaving a white bonnet, roof and boot: the classic panda read.
      ctx.fillStyle = '#0b0f18';
      roundRect(ctx, -L * 0.30, -W / 2, L * 0.30, W, 3);
      ctx.fill();
      roundRect(ctx, L * 0.06, -W / 2, L * 0.22, W, 3);
      ctx.fill();
      // A hard white band across the middle, which is what reads from a distance.
      ctx.fillStyle = '#eef2ff';
      ctx.fillRect(-L * 0.36, -W / 2, L * 0.06, W);
      ctx.fillRect(-L * 0.02, -W / 2, L * 0.07, W);
      // Blue accent pinstripes along the flanks.
      ctx.fillStyle = '#2f5fe0';
      ctx.fillRect(-L * 0.34, -W / 2 + 1, L * 0.7, 2.2);
      ctx.fillRect(-L * 0.34, W / 2 - 3.2, L * 0.7, 2.2);
      // Roof unit: a dark plinth carrying a wide red/blue bar that alternates as it flashes.
      ctx.fillStyle = '#0d1220';
      roundRect(ctx, -L * 0.13, -W * 0.42, L * 0.26, W * 0.84, 2);
      ctx.fill();
      const flash = Math.floor(state.clock * 7) % 2 === 0;
      ctx.save();
      ctx.shadowBlur = 22;
      // Left half red, right half blue, swapping brightness so the bar strobes.
      ctx.shadowColor = '#ff2b4a';
      ctx.fillStyle = flash ? '#ff5b70' : '#8f1b2c';
      ctx.fillRect(-L * 0.11, -W * 0.38, L * 0.11, W * 0.36);
      ctx.shadowColor = '#3d7bff';
      ctx.fillStyle = flash ? '#1e3f8f' : '#5f97ff';
      ctx.fillRect(-L * 0.11, W * 0.02, L * 0.11, W * 0.36);
      ctx.restore();
      // A coloured wash spilling onto the roof and the road, so the bar lights the car itself.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const wash = ctx.createRadialGradient(-L * 0.05, 0, 0, -L * 0.05, 0, L * 0.5);
      wash.addColorStop(0, flash ? 'rgba(255,60,90,0.34)' : 'rgba(60,110,255,0.34)');
      wash.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = wash;
      ctx.beginPath();
      ctx.arc(-L * 0.05, 0, L * 0.5, 0, TAU);
      ctx.fill();
      ctx.restore();
      // "POLICE" stencilled on the doors: two thick marks that read as lettering at size.
      ctx.fillStyle = 'rgba(225,235,255,0.9)';
      ctx.fillRect(-L * 0.26, -W * 0.16, L * 0.17, 2);
      ctx.fillRect(-L * 0.26, -W * 0.02, L * 0.12, 2);
    }

    // Damage: dark scorch and holes once it is beaten up.
    if (car.health < car.maxHealth * 0.6) {
      const dmg = 1 - car.health / car.maxHealth;
      ctx.fillStyle = `rgba(8,6,10,${0.15 + dmg * 0.4})`;
      ctx.beginPath();
      ctx.ellipse(-L * 0.2, W * 0.1, L * 0.2, W * 0.22, 0, 0, TAU);
      ctx.fill();
      for (let i = 0; i < car.bulletHoles.length; i += 1) {
        const h = car.bulletHoles[i];
        ctx.fillStyle = 'rgba(4,4,8,0.9)';
        ctx.beginPath();
        ctx.arc(h.x, h.y, 1.4, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    // A marker over the car the player is driving, and over a mission target.
    if (state.player.car === car) {
      ctx.save();
      ctx.strokeStyle = srgb(PALETTE.neonCyan, 0.75);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(p.x - 5, p.y - L * 0.5 * z - 12);
      ctx.lineTo(p.x + 5, p.y - L * 0.5 * z - 12);
      ctx.lineTo(p.x, p.y - L * 0.5 * z - 5);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPickup(pk, cam, sh, state) {
    if (pk.taken) return;
    const p = toScreen(pk.x, pk.y, cam, sh.x, sh.y);
    if (p.x < -30 || p.x > VIEW.width + 30 || p.y < -30 || p.y > VIEW.height + 30) return;
    const bob = Math.sin(state.clock * 2 + pk.bob) * 2.5;
    const col = pk.kind === 'health' ? PALETTE.neonRed : pk.kind === 'armour' ? PALETTE.policeBlue : pk.kind === 'ammo' ? PALETTE.neonAmber : PALETTE.money;
    ctx.save();
    ctx.translate(p.x, p.y - 8 + bob * cam.zoom);
    ctx.shadowColor = col;
    ctx.shadowBlur = 16;
    ctx.fillStyle = srgb(col, 0.95);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-4.5 * cam.zoom, -4.5 * cam.zoom, 9 * cam.zoom, 9 * cam.zoom);
    ctx.restore();
    // A ground ring so it is findable from a distance.
    ctx.save();
    ctx.strokeStyle = srgb(col, 0.25);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 12 * cam.zoom, 12 * cam.zoom * YSQ, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- sorted pass */

  // Cars that must survive a building in front of them (the player's, and police).
  const xray = [];

  function drawSorted(state, cam, sh) {
    const { city } = state;
    const z = cam.zoom;
    const halfW = VIEW.width / 2 / z + 140;
    const halfH = VIEW.height / 2 / (z * YSQ) + 220;
    const x0 = cam.x - halfW;
    const x1 = cam.x + halfW;
    const y0 = cam.y - halfH;
    const y1 = cam.y + halfH;
    const list = state.drawList;
    list.length = 0;

    for (let i = 0; i < city.solids.length; i += 1) {
      const b = city.solids[i];
      if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
      list.push({ k: b.y + b.h, t: 0, o: b });
    }
    for (let i = 0; i < state.cars.length; i += 1) {
      const c = state.cars[i];
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      list.push({ k: c.y + c.spec.len * 0.3, t: 1, o: c });
    }
    for (let i = 0; i < state.peds.length; i += 1) {
      const p = state.peds[i];
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      list.push({ k: p.y + 4, t: 2, o: p });
    }
    for (let i = 0; i < state.cops.length; i += 1) {
      const c = state.cops[i];
      if (c.mode !== 'foot') continue;
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      list.push({ k: c.y + 4, t: 3, o: c });
    }
    for (let i = 0; i < state.pickups.length; i += 1) {
      const pk = state.pickups[i];
      if (pk.taken) continue;
      if (pk.x < x0 || pk.x > x1 || pk.y < y0 || pk.y > y1) continue;
      list.push({ k: pk.y, t: 4, o: pk });
    }
    // The player is an entity too; in a car the car is drawn where the player is.
    const pl = state.player;
    if (!pl.inCar && !pl.dead) list.push({ k: pl.y + 3, t: 5, o: pl });

    list.sort((a, b) => a.k - b.k);

    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      if (e.t === 0) {
        const b = e.o;
        const s = spriteFor(b);
        const p = toScreen(b.x, b.y, cam, sh.x, sh.y);
        ctx.drawImage(s.canvas, p.x + s.ox * z, p.y + s.oy * z, s.w * z, s.h * z);
      } else if (e.t === 1) {
        // Anything the camera must never lose — the car you are driving, and every police car —
        // remembers where it was drawn so the see-through pass can redraw it above the skyline.
        if (e.o.police || e.o === state.player.car) xray.push(e.o);
        drawCar(e.o, cam, sh, state);
      } else if (e.t === 2) drawPed(e.o, cam, sh, state);
      else if (e.t === 3) drawCopFoot(e.o, cam, sh, state);
      else if (e.t === 4) drawPickup(e.o, cam, sh, state);
      else if (e.t === 5) drawPlayer(pl, cam, sh, state);
    }

    // See-through pass. A tall block south of the action can hide the player's car or a cruiser,
    // which makes a chase unreadable. Redraw those entities at reduced alpha on top of the
    // skyline: still visibly occluded by the building, but never lost behind it.
    for (let i = 0; i < xray.length; i += 1) {
      const car = xray[i];
      if (car.wrecked && !car.police) continue;
      const behind = occludedBy(city, car.x, car.y);
      if (!behind) continue;
      ctx.save();
      ctx.globalAlpha = 0.55;
      drawCar(car, cam, sh, state);
      ctx.restore();
    }
    xray.length = 0;
  }

  /**
   * True when a building sprite covers this world point. Uses the same geometry the sprite is
   * drawn with: the footprint squashed by YSQ, extruded upward by HY * height, and skewed left by
   * HX * height. A block only occludes if it stands in front of the point (its base is south).
   */
  function occludedBy(city, x, y) {
    for (let i = 0; i < city.solids.length; i += 1) {
      const b = city.solids[i];
      if (b.y <= y) continue;
      const dx = -HX * b.height;
      const dy = -HY * b.height;
      const hb = b.h * YSQ;
      const lx = x - b.x;
      const ly = (y - b.y) * YSQ;
      if (ly < dy || ly > hb) continue;
      if (lx < Math.min(0, dx) || lx > Math.max(b.w, b.w + dx)) continue;
      return true;
    }
    return false;
  }

  function drawCopFoot(cop, cam, sh, state) {
    const p = toScreen(cop.x, cop.y, cam, sh.x, sh.y);
    const z = cam.zoom;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(z, z * YSQ);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(1.5, 2, 7.8, 4.2, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(cop.angle);
    ctx.fillStyle = '#1a2140';
    ctx.beginPath();
    ctx.ellipse(-0.5, 0, 5, 5.4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#2f5fe0';
    ctx.fillRect(-3, -4.4, 4, 8.8);
    ctx.fillStyle = '#d8b48f';
    ctx.beginPath();
    ctx.arc(1.6, 0, 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#0c0d14';
    ctx.fillRect(2.6, -4.4, 6, 2);
    ctx.restore();
    // A blue ring so officers read against the street.
    ctx.save();
    ctx.strokeStyle = srgb(PALETTE.policeBlue, 0.55 + Math.sin(state.clock * 6) * 0.2);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 10 * z, 6 * z, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function drawPlayer(p, cam, sh, state) {
    const s = toScreen(p.x, p.y, cam, sh.x, sh.y);
    const z = cam.zoom;
    // Blink while briefly invulnerable after a hit.
    const blink = p.invuln > 0 && Math.floor(state.clock * 12) % 2 === 0 ? 0.35 : 1;

    // A soft pool of light at the protagonist's feet. Every other figure on the street is lit by
    // whatever happens to be nearby; the player always carries their own light, which is what
    // makes them findable in a crowd at night without resorting to a marker.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pool = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 46 * z);
    pool.addColorStop(0, 'rgba(120,190,255,0.16)');
    pool.addColorStop(0.45, 'rgba(80,140,220,0.07)');
    pool.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, 46 * z, 40 * z * YSQ, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = blink;
    ctx.translate(s.x, s.y);
    ctx.scale(z * PED_SCALE, z * YSQ * PED_SCALE);
    // Contact shadow, cast down-right like everyone else's.
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.ellipse(3, 3.4, 6.2, 3.0, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(p.angle);
    const step = Math.sin(state.clock * 9) * 1.6;
    // Legs, swinging: the cue that says this figure is moving.
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(-2.6, -4.4 + step * 0.5, 2.8, 4.6);
    ctx.fillRect(-2.6, -0.2 - step * 0.5, 2.8, 4.6);
    // Long coat: the player's silhouette is a broad-shouldered capsule with a hem that trails
    // behind, deliberately different from the round civilian blobs.
    // Rim outline first, drawn as a fatter copy of the same polygon. A near-black coat on wet
    // asphalt disappears without it; the cyan rim is what keeps the protagonist findable.
    ctx.fillStyle = 'rgba(88,225,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(-7.1, -4.4);
    ctx.lineTo(1.8, -5.9);
    ctx.lineTo(5.2, -2.6);
    ctx.lineTo(5.2, 2.6);
    ctx.lineTo(1.8, 5.9);
    ctx.lineTo(-7.1, 4.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0f1524';
    ctx.beginPath();
    ctx.moveTo(-6.4, -4.0);
    ctx.lineTo(1.6, -5.3);
    ctx.lineTo(4.6, -2.4);
    ctx.lineTo(4.6, 2.4);
    ctx.lineTo(1.6, 5.3);
    ctx.lineTo(-6.4, 4.0);
    ctx.closePath();
    ctx.fill();
    // Coat highlight down the leading edge, which is what catches the neon.
    const coatG = ctx.createLinearGradient(4.6, -4, -6.4, 4);
    coatG.addColorStop(0, 'rgba(63,242,228,0.30)');
    coatG.addColorStop(0.6, 'rgba(30,44,74,0)');
    ctx.fillStyle = coatG;
    ctx.beginPath();
    ctx.moveTo(-6.4, -4.0);
    ctx.lineTo(1.6, -5.3);
    ctx.lineTo(4.6, -2.4);
    ctx.lineTo(4.6, 2.4);
    ctx.lineTo(1.6, 5.3);
    ctx.lineTo(-6.4, 4.0);
    ctx.closePath();
    ctx.fill();
    // A collar, so the shoulders read as shoulders.
    ctx.strokeStyle = 'rgba(120,150,200,0.55)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0.8, -4.8);
    ctx.lineTo(2.4, 0);
    ctx.lineTo(0.8, 4.8);
    ctx.stroke();
    // Head.
    ctx.fillStyle = '#e0bb9c';
    ctx.beginPath();
    ctx.arc(2.2, 0, 3.0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1b2233';
    ctx.beginPath();
    ctx.arc(1.2, 0, 3.0, 1.9, 4.4);
    ctx.fill();
    // Arm + weapon when aiming.
    if (p.aiming) {
      ctx.fillStyle = '#2a3550';
      ctx.fillRect(1, -4.6, 6.4, 2.2);
      ctx.fillStyle = '#0a0b12';
      ctx.fillRect(6.2, -4.2, 6.4, 1.8);
    }
    ctx.restore();
    // Cyan chevron over the player: always findable. Drawn in screen space so it stays a constant
    // readable size regardless of the character scale.
    const bob = Math.sin(state.clock * 4) * 1.5;
    ctx.save();
    ctx.shadowColor = PALETTE.neonCyan;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = srgb(PALETTE.neonCyan, 0.95);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x - 9, s.y - 34 + bob);
    ctx.lineTo(s.x + 9, s.y - 34 + bob);
    ctx.lineTo(s.x, s.y - 23 + bob);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;

    // Aim line and crosshair.
    if (p.aiming && state.ui.aim) {
      const aw = state.ui.aim;
      ctx.save();
      ctx.strokeStyle = srgb(PALETTE.neonCyan, 0.16);
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 4);
      ctx.lineTo(aw.sx, aw.sy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = srgb(PALETTE.neonCyan, 0.9);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(aw.sx, aw.sy, 8, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(aw.sx - 13, aw.sy); ctx.lineTo(aw.sx - 5, aw.sy);
      ctx.moveTo(aw.sx + 5, aw.sy); ctx.lineTo(aw.sx + 13, aw.sy);
      ctx.moveTo(aw.sx, aw.sy - 13); ctx.lineTo(aw.sx, aw.sy - 5);
      ctx.moveTo(aw.sx, aw.sy + 5); ctx.lineTo(aw.sx, aw.sy + 13);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- overlays */

  function drawBullets(state, cam, sh) {
    const b = state.bullets;
    for (let i = 0; i < b.length; i += 1) {
      const t = b[i];
      const a = toScreen(t.px, t.py, cam, sh.x, sh.y);
      const c = toScreen(t.x, t.y, cam, sh.x, sh.y);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = srgb(t.colour, 0.85);
      ctx.lineWidth = 1.8 * cam.zoom;
      ctx.shadowColor = t.colour;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles(state, cam, sh) {
    const ps = state.particles;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < ps.length; i += 1) {
      const pt = ps[i];
      const life = clamp(pt.life / pt.maxLife, 0, 1);
      const s = toScreen(pt.x, pt.y, cam, sh.x, sh.y);
      if (s.x < -20 || s.x > VIEW.width + 20 || s.y < -20 || s.y > VIEW.height + 20) continue;
      if (pt.kind === 'smoke') {
        ctx.fillStyle = srgb('#8a7f96', life * 0.16);
        ctx.beginPath();
        ctx.arc(s.x, s.y, pt.size * 3 * cam.zoom * (1.6 - life), 0, TAU);
        ctx.fill();
      } else {
        ctx.fillStyle = srgb(pt.colour, life * 0.9);
        ctx.fillRect(s.x, s.y, pt.size * cam.zoom * life + 0.6, pt.size * cam.zoom * life + 0.6);
      }
    }
    ctx.restore();

    // Floating money / damage numbers.
    for (let i = 0; i < state.floaters.length; i += 1) {
      const f = state.floaters[i];
      const s = toScreen(f.x, f.y, cam, sh.x, sh.y);
      ctx.globalAlpha = clamp(f.life, 0, 1);
      text(f.text, s.x, s.y, 13, f.colour, 'center', 'middle', 800);
      ctx.globalAlpha = 1;
    }
  }

  /** Police are always readable: a strobing halo and a chevron over every cruiser on screen. */
  function drawPoliceOverlay(state, cam, sh) {
    const z = cam.zoom;
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (!car.police) continue;
      const p = toScreen(car.x, car.y, cam, sh.x, sh.y);
      if (p.x < -60 || p.x > VIEW.width + 60 || p.y < -60 || p.y > VIEW.height + 60) continue;
      const flash = Math.floor(state.clock * 7 + i) % 2 === 0;
      const col = flash ? PALETTE.policeRed : PALETTE.policeBlue;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 62 * z);
      g.addColorStop(0, srgb(col, 0.4));
      g.addColorStop(0.45, srgb(col, 0.13));
      g.addColorStop(1, srgb(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 62 * z, 62 * z * YSQ, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      // Chevron + label above the car.
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 10;
      ctx.fillStyle = srgb(col, 0.95);
      ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y - 30);
      ctx.lineTo(p.x + 6, p.y - 30);
      ctx.lineTo(p.x, p.y - 22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawRain(state) {
    const r = state.weather.rain;
    if (r <= 0.01) return;
    const t = state.clock;
    const n = Math.floor(150 * r);
    ctx.save();
    ctx.strokeStyle = 'rgba(150,190,235,0.20)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const seedX = ((i * 317.7 + t * 420) % (VIEW.width + 280)) - 140;
      const seedY = ((i * 173.3 + t * 1180) % (VIEW.height + 200)) - 100;
      const len = 12 + (i % 5) * 5;
      ctx.moveTo(seedX, seedY);
      ctx.lineTo(seedX - len * 0.42, seedY + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawGrade(state) {
    // Wet city grade. Contrast is the whole look, so this is a real curve rather than a wash:
    // a light multiply pulls the shadows off grey, then an additive radial lift puts the light
    // back into the middle of the frame so the lamps and the neon still read as sources.
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(206,198,228,0.55)';
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const lift = ctx.createRadialGradient(
      VIEW.width * 0.5, VIEW.height * 0.54, 0,
      VIEW.width * 0.5, VIEW.height * 0.54, VIEW.height * 0.88,
    );
    lift.addColorStop(0, 'rgba(34,28,60,0.62)');
    lift.addColorStop(0.5, 'rgba(18,15,34,0.30)');
    lift.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lift;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    ctx.restore();

    // Vignette, tighter and darker than before to frame the action.
    const g = ctx.createRadialGradient(VIEW.width * 0.5, VIEW.height * 0.5, VIEW.height * 0.3, VIEW.width * 0.5, VIEW.height * 0.5, VIEW.height * 1.02);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.58, 'rgba(4,3,10,0.20)');
    g.addColorStop(1, 'rgba(2,1,6,0.84)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);

    // Scanline grain, deterministic and very subtle.
    const t = state.clock;
    ctx.save();
    ctx.globalAlpha = 0.030;
    ctx.fillStyle = '#8f9ecf';
    for (let y = 0; y < VIEW.height; y += 3) ctx.fillRect(0, y, VIEW.width, 1);
    ctx.restore();

    // A slow dusk wash: the city drifts from violet to deep blue as the night goes on.
    const phase = (Math.sin(t * 0.01) + 1) / 2;
    ctx.fillStyle = phase < 0.5
      ? `rgba(74,26,116,${0.055 * (1 - phase * 2)})`
      : `rgba(16,44,104,${0.055 * (phase * 2 - 1)})`;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  }

  /* ---------------------------------------------------------------- bloom */

  const bloomA = document.createElement('canvas');
  let bloomReady = false;

  /**
   * A cheap two-tap bloom: downsample the frame, threshold it with a 'lighter' pass, blur it by
   * drawing it small and scaling back up, then add it over the frame. This is what makes the neon
   * read as light rather than as coloured rectangles.
   */
  function applyBloom() {
    if (!bloomA.getContext) return;
    const w = 320;
    const h = Math.max(180, Math.round((w * VIEW.height) / VIEW.width));
    if (!bloomReady) {
      bloomA.width = w; bloomA.height = h;
      bloomReady = true;
    }
    const a = bloomA.getContext('2d');
    if (!a) return;
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, w, h);
    // Squash the whole frame down: bright pixels dominate after this.
    a.drawImage(canvas, view.x, view.y, VIEW.width * view.scale, VIEW.height * view.scale, 0, 0, w, h);
    // Keep only the hot pixels. Two multiplies of the downsampled frame squares it, which lifts
    // only genuine light sources — one multiply left mid-tone car bodies glowing and smeared the
    // silhouettes into each other.
    a.globalCompositeOperation = 'multiply';
    a.drawImage(bloomA, 0, 0);
    a.drawImage(bloomA, 0, 0);
    a.drawImage(bloomA, 0, 0);
    a.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.42;
    ctx.drawImage(bloomA, 0, 0,
      VIEW.width, VIEW.height);
    ctx.globalAlpha = 0.24;
    ctx.drawImage(bloomA, -6 * view.scale, -6 * view.scale, VIEW.width + 12 * view.scale, VIEW.height + 12 * view.scale);
    ctx.restore();
  }

  /** The whole frame. */
  function draw(state, screen, ui) {
    state.ui = ui || {};
    const cam = state.camera;
    const sh = { x: 0, y: 0 };
    if (cam.shake > 0.05) {
      // Deterministic shake: derived from the frame counter, not Math.random.
      const a = (state.frame % 360) * 0.01745 * 7.3;
      sh.x = Math.cos(a) * cam.shake;
      sh.y = Math.sin(a) * cam.shake * YSQ;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05040a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
    ctx.beginPath();
    ctx.rect(0, 0, VIEW.width, VIEW.height);
    ctx.clip();

    if (!state.player) return;

    drawGround(state, cam, sh);
    drawProps(state, cam, sh);
    drawSkids(state, cam, sh);
    drawPools(state, cam, sh);
    drawSorted(state, cam, sh);
    drawBullets(state, cam, sh);
    drawParticles(state, cam, sh);
    drawPoliceOverlay(state, cam, sh);
    applyBloom();

    // Muzzle flash is part of the particles above; the screen flash for damage sits here.
    if (state.player.hurtFlash > 0) {
      ctx.fillStyle = `rgba(150,10,30,${clamp(state.player.hurtFlash, 0, 0.5)})`;
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    }

    drawRain(state);
    drawGrade(state);
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  resize();
  window.addEventListener('resize', resize);
  return { draw, resize, toWorld, toScreen, font, text, roundRect, ctx, view, spriteFor };
}
