// Interface only: everything painted after the world, in screen space. The HUD is drawn with the
// same oblique-friendly typography as the city — thin caps, a heavy condensed title face, neon
// underlines — and the minimap is a direct redraw of the city grid so it can never disagree with
// the streets underfoot.
import { FONT, MONO, PALETTE, VIEW, YSQ } from './config.js';
import { alpha, clamp, money, TAU } from './util.js';
import { CHARACTERS } from './missions.js';

const C = PALETTE;

function bar(ctx, x, y, w, h, value, colour, bg = 'rgba(8,10,20,0.88)') {
  const v = clamp(value, 0, 1);
  // Trough: a real inset socket, so an empty bar still reads as a bar rather than a gap.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  // Segment ticks every 25% give the bar a scale.
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const tx = Math.round(x + (w * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(tx, y + 1);
    ctx.lineTo(tx, y + h - 1);
    ctx.stroke();
  }
  if (v > 0) {
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, colour);
    grad.addColorStop(0.55, colour);
    grad.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w * v, h);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x, y, w * v, 1.5);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

export function createHud(renderer) {
  const { ctx } = renderer;
  let t = 0;

  function setFont(size, weight = 600, mono = false) {
    ctx.font = `${weight} ${size}px ${mono ? MONO : FONT}`;
  }

  function label(value, x, y, size, colour, align = 'left', weight = 600, mono = false, spacing = 0) {
    setFont(size, weight, mono);
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    if (spacing === 0) {
      ctx.fillText(value, x, y);
      return;
    }
    // Letter spacing withoutTextMetrics: draw one character at a time.
    const chars = [...value];
    let total = 0;
    for (const ch of chars) total += ctx.measureText(ch).width + spacing;
    total -= spacing;
    let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    for (const ch of chars) {
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + spacing;
    }
  }

  /* ---------------------------------------------------------------- minimap */

  const MAP = { size: 168, x: VIEW.width - 168 - 24, y: 24 };

  function drawMinimap(state, cx, cy) {
    const { city } = state;
    const S = MAP.size;
    const span = 2100; // world units across the map
    const k = S / span;
    const x0 = MAP.x;
    const y0 = MAP.y;

    ctx.save();
    // Panel: opaque enough that the street grid behind it cannot be mistaken for the map itself,
    // with a hard inner border and a soft outer glow so it reads as an instrument.
    ctx.fillStyle = 'rgba(6,8,16,0.94)';
    ctx.beginPath();
    renderer.roundRect(ctx, x0 - 7, y0 - 7, S + 14, S + 14, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,220,255,0.42)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    renderer.roundRect(ctx, x0 - 5, y0 - 5, S + 10, S + 10, 8);
    ctx.stroke();
    ctx.beginPath();
    renderer.roundRect(ctx, x0, y0, S, S, 6);
    ctx.clip();

    ctx.fillStyle = '#0d1220';
    ctx.fillRect(x0, y0, S, S);

    // Streets as a bright grid.
    ctx.strokeStyle = 'rgba(130,150,200,0.30)';
    ctx.lineWidth = Math.max(1.2, (city.road * k));
    for (let i = 0; i <= city.grid; i += 1) {
      const p = (i * city.cell - cx) * k + S / 2;
      ctx.beginPath(); ctx.moveTo(x0 + p, y0); ctx.lineTo(x0 + p, y0 + S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y0 + p); ctx.lineTo(x0 + S, y0 + p); ctx.stroke();
    }
    // Blocks.
    ctx.fillStyle = 'rgba(40,46,70,0.85)';
    for (let i = 0; i < city.blocks.length; i += 1) {
      const b = city.blocks[i];
      const bx = (b.x + b.w / 2 - cx) * k + S / 2 - (b.w * k) / 2;
      const by = (b.y + b.h / 2 - cy) * k + S / 2 - (b.h * k) / 2;
      if (bx > S || bx + b.w * k < 0 || by > S || by + b.h * k < 0) continue;
      ctx.fillStyle = b.park ? 'rgba(46,92,66,0.85)' : 'rgba(38,44,66,0.9)';
      ctx.fillRect(x0 + bx, y0 + by, b.w * k, b.h * k);
      // Taller buildings glow a little brighter on the map.
      if (!b.park) {
        for (const bd of b.buildings) {
          const gx = x0 + (bd.x + bd.w / 2 - cx) * k + S / 2;
          const gy = y0 + (bd.y + bd.h / 2 - cy) * k + S / 2;
          ctx.fillStyle = bd.neon ? alpha(bd.neon, 0.5) : 'rgba(70,80,110,0.8)';
          ctx.fillRect(gx - 1, gy - 1, 2.4, 2.4);
        }
      }
    }
    // Water.
    const wx = x0 + (city.water.x - cx) * k + S / 2;
    ctx.fillStyle = '#0a1a2a';
    ctx.fillRect(wx, y0, S, S);

    // Mission marker.
    const marker = state.missionMarker;
    if (marker) {
      const mx = x0 + (marker.x - cx) * k + S / 2;
      const my = y0 + (marker.y - cy) * k + S / 2;
      ctx.save();
      ctx.shadowColor = marker.colour;
      ctx.shadowBlur = 8;
      ctx.fillStyle = marker.colour;
      ctx.beginPath();
      ctx.moveTo(mx, my - 6);
      ctx.lineTo(mx + 5, my);
      ctx.lineTo(mx, my + 6);
      ctx.lineTo(mx - 5, my);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Cops.
    for (let i = 0; i < state.cars.length; i += 1) {
      const c = state.cars[i];
      if (!c.police) continue;
      const cxp = x0 + (c.x - cx) * k + S / 2;
      const cyp = y0 + (c.y - cy) * k + S / 2;
      ctx.fillStyle = Math.floor(t * 6) % 2 === 0 ? C.policeRed : C.policeBlue;
      ctx.fillRect(cxp - 2, cyp - 2, 4, 4);
    }
    // Civilians as tiny dust, only nearby.
    ctx.fillStyle = 'rgba(200,210,240,0.30)';
    for (let i = 0; i < state.peds.length; i += 2) {
      const p = state.peds[i];
      if (p.dead) continue;
      const px = x0 + (p.x - cx) * k + S / 2;
      const py = y0 + (p.y - cy) * k + S / 2;
      if (px < 0 || px > S || py < 0 || py > S) continue;
      ctx.fillRect(px, py, 1.4, 1.4);
    }
    // Player arrow, rotated to facing.
    const angle = state.player.inCar && state.player.car ? state.player.car.angle : state.player.angle;
    ctx.save();
    ctx.translate(x0 + S / 2, y0 + S / 2);
    ctx.rotate(angle + Math.PI / 2);
    ctx.shadowColor = C.neonCyan;
    ctx.shadowBlur = 8;
    ctx.fillStyle = C.neonCyan;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // North marker in the top corner of the map, and the district name in a footer strip that is
    // part of the panel rather than floating outside it.
    label('N', MAP.x + S - 13, MAP.y + 16, 11, 'rgba(220,235,255,0.55)', 'center', 700, true);
    const district = city.districtName(state.player.x, state.player.y);
    ctx.fillStyle = 'rgba(4,6,12,0.92)';
    ctx.fillRect(MAP.x, MAP.y + S - 20, S, 20);
    ctx.strokeStyle = 'rgba(120,220,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MAP.x, MAP.y + S - 20);
    ctx.lineTo(MAP.x + S, MAP.y + S - 20);
    ctx.stroke();
    label(district, MAP.x + S / 2, MAP.y + S - 6, 11, 'rgba(215,230,255,0.92)', 'center', 700, false, 1.6);
  }

  /* ---------------------------------------------------------------- HUD */

  function drawPlayerHud(state) {
    const p = state.player;

    // Money, top left.
    label(money(p.money), 26, 46, 32, C.money, 'left', 800, true);
    label('CLEAN', 28, 63, 11, 'rgba(150,220,180,0.7)', 'left', 700, false, 3);

    // Health / armour bars.
    bar(ctx, 26, 76, 200, 13, p.health / 100, p.health > 35 ? '#3ce08a' : '#ff4d5e');
    bar(ctx, 26, 94, 200, 9, p.armour / 100, '#59a6ff');
    label('HP', 234, 87, 10, 'rgba(220,235,255,0.72)', 'left', 700, true);
    label('AR', 234, 103, 10, 'rgba(140,180,255,0.78)', 'left', 700, true);

    // Wanted stars, under the bars.
    for (let i = 0; i < 5; i += 1) {
      const filled = i < p.wanted;
      const starX = 26 + i * 24;
      drawStar(starX + 9, 128, filled, i);
    }
    if (p.wanted > 0) {
      const pulse = 0.45 + Math.sin(t * 5) * 0.25;
      label('WANTED', 152, 133, 11, alpha(C.neonRed, pulse + 0.35), 'left', 800, true);
    }

    // Weapon + ammo, bottom left.
    const w = state.weaponDef;
    if (w) {
      const boxY = VIEW.height - 66;
      ctx.fillStyle = 'rgba(8,9,18,0.72)';
      renderer.roundRect(ctx, 22, boxY, 176, 44, 7);
      ctx.fill();
      ctx.strokeStyle = alpha(w.tracer, 0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
      label(w.name, 34, boxY + 18, 11, alpha(w.tracer, 0.9), 'left', 800, false, 2.2);
      const ammo = p.ammo[p.weapon];
      const ammoText = ammo === Infinity ? '∞' : String(ammo);
      label(ammoText, 34, boxY + 37, 17, C.text, 'left', 700, true);
      label('RMB AIM · LMB FIRE · 1-3 SWITCH', 188, boxY + 37, 8.5, 'rgba(180,195,225,0.45)', 'right', 600, false, 0.8);
    }

    // Speedometer while driving.
    if (p.inCar && p.car) {
      const car = p.car;
      const speed = Math.round(Math.hypot(car.vx, car.vy) * 0.36);
      const cx = VIEW.width - 118;
      const cy = VIEW.height - 96;
      ctx.save();
      ctx.fillStyle = 'rgba(8,9,18,0.68)';
      ctx.beginPath();
      ctx.arc(cx, cy, 62, Math.PI * 0.78, Math.PI * 2.22);
      ctx.lineTo(cx + 52, cy + 40);
      ctx.lineTo(cx - 52, cy + 40);
      ctx.closePath();
      ctx.fill();
      // Arc.
      const frac = clamp(speed / 320, 0, 1);
      ctx.strokeStyle = frac > 0.8 ? C.neonRed : frac > 0.55 ? C.neonAmber : C.neonCyan;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, 48, Math.PI * 0.8, Math.PI * 0.8 + Math.PI * 1.4 * frac);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 48, Math.PI * 0.8, Math.PI * 2.2);
      ctx.stroke();
      ctx.restore();
      label(String(speed), cx, cy + 6, 30, C.text, 'center', 800, true);
      label('KM/H', cx, cy + 22, 9, 'rgba(190,205,235,0.6)', 'center', 700, false, 2.4);
      label(car.spec.name.toUpperCase(), cx, cy + 38, 10, alpha(C.neonCyan, 0.8), 'center', 800, false, 2);
      // Damage pips.
      for (let i = 0; i < 8; i += 1) {
        const filled = i < Math.ceil((car.health / car.maxHealth) * 8);
        ctx.fillStyle = filled ? (car.health < car.maxHealth * 0.35 ? C.neonRed : 'rgba(120,255,200,0.7)') : 'rgba(255,255,255,0.10)';
        ctx.fillRect(cx - 34 + i * 9, cy + 46, 6, 3);
      }
    }

    // Objective line, top centre.
    if (state.objective) {
      const tw = ctx.measureText(state.objective).width;
      setFont(13, 700, false);
      const w2 = ctx.measureText(state.objective).width + 44;
      ctx.fillStyle = 'rgba(6,7,14,0.72)';
      renderer.roundRect(ctx, VIEW.width / 2 - w2 / 2, 20, w2, 30, 6);
      ctx.fill();
      ctx.fillStyle = alpha(C.neonAmber, 0.85);
      ctx.fillRect(VIEW.width / 2 - w2 / 2, 20, 3, 30);
      label(state.objective, VIEW.width / 2 + 2, 40, 13, C.text, 'center', 700);
      if (state.active && state.active.timer > 0) {
        const secs = Math.max(0, Math.ceil(state.active.timer));
        label(`${secs}s`, VIEW.width / 2, 68, 15, secs < 15 ? C.neonRed : C.neonAmber, 'center', 800, true);
      }
    }
  }

  function drawStar(cx, cy, filled, index) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 === 0 ? 8.4 : 3.8;
      const a = (i / 10) * TAU - Math.PI / 2;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    if (filled) {
      const pulse = index === 4 ? 0.7 + Math.sin(t * 8) * 0.3 : 1;
      ctx.shadowColor = C.neonAmber;
      ctx.shadowBlur = 10;
      ctx.fillStyle = alpha(C.neonAmber, pulse);
      ctx.fill();
      ctx.strokeStyle = '#fff2c4';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(190,205,235,0.45)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- banners */

  function drawMissionMarkerOnScreen(state) {
    const m = state.missionMarker;
    if (!m) return;
    const cam = state.camera;
    const p = renderer.toScreen(m.x, m.y, cam);
    const onScreen = p.x > 40 && p.x < VIEW.width - 40 && p.y > 40 && p.y < VIEW.height - 40;
    if (onScreen) {
      const bob = Math.sin(t * 2.4) * 3;
      ctx.save();
      ctx.translate(p.x, p.y - 30 + bob);
      ctx.shadowColor = m.colour;
      ctx.shadowBlur = 18;
      ctx.strokeStyle = m.colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(9, 0);
      ctx.lineTo(0, 12);
      ctx.lineTo(-9, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = alpha(m.colour, 0.18);
      ctx.fill();
      ctx.restore();
      label(CHARACTERS[m.name] ? CHARACTERS[m.name].name : m.title, p.x, p.y - 52 + bob, 11, m.colour, 'center', 800, false, 2);
      label('PRESS F', p.x, p.y - 66 + bob, 9, 'rgba(230,240,255,0.7)', 'center', 700, false, 1.6);
    } else {
      // Off-screen: an arrow at the frame edge pointing to it.
      const cx = VIEW.width / 2;
      const cy = VIEW.height / 2;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const a = Math.atan2(dy, dx);
      const r = 240;
      const ex = cx + Math.cos(a) * r;
      const ey = cy + Math.sin(a) * r;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.fillStyle = alpha(m.colour, 0.9);
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-6, 6);
      ctx.lineTo(-6, -6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      label(m.title, ex, ey + (Math.sin(a) > 0 ? 22 : -14), 9.5, alpha(m.colour, 0.85), 'center', 800, false, 1.4);
    }
  }

  function drawBanner(state) {
    if (!state.bannerText || state.missionBannerT <= 0) return;
    const b = state.bannerText;
    const fade = clamp(Math.min(state.missionBannerT, 1.2), 0, 1);
    const slide = (1 - clamp(state.missionBannerT / 5.5, 0, 1)) * 20;
    ctx.save();
    ctx.globalAlpha = fade;
    const w = 620;
    const x = VIEW.width / 2 - w / 2;
    const y = 150 + slide;
    const g = ctx.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, 'rgba(6,7,14,0)');
    g.addColorStop(0.12, 'rgba(6,7,14,0.86)');
    g.addColorStop(0.88, 'rgba(6,7,14,0.86)');
    g.addColorStop(1, 'rgba(6,7,14,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, 86);
    ctx.fillStyle = b.colour;
    ctx.fillRect(x + 40, y + 70, w - 80, 2);
    label(b.title, VIEW.width / 2, y + 34, 30, b.colour, 'center', 800, false, 4);
    // Speaker line: a job with no name attached has no stakes, so the giver is always credited.
    if (b.speaker) {
      label(`${b.speaker} — ${b.role ? b.role.toUpperCase() : ''}`, VIEW.width / 2, y + 52, 11,
        alpha(b.colour, 0.82), 'center', 800, false, 2);
      label(`"${b.sub}"`, VIEW.width / 2, y + 70, 13, 'rgba(235,242,255,0.92)', 'center', 600);
    } else {
      label(b.sub, VIEW.width / 2, y + 58, 13, 'rgba(225,235,255,0.85)', 'center', 600);
    }
    ctx.restore();
  }

  function drawToast(state) {
    if (!state.toast || state.toast.life <= 0) return;
    const a = clamp(state.toast.life, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    label(state.toast.text, VIEW.width / 2, VIEW.height - 54, 15, state.toast.colour, 'center', 800, false, 2);
    ctx.restore();
  }

  /** Low health: the frame goes red at the edges. */
  function drawHurtVignette(state) {
    const hp = state.player.health / 100;
    if (hp > 0.35) return;
    const a = (0.35 - hp) / 0.35;
    const g = ctx.createRadialGradient(VIEW.width / 2, VIEW.height / 2, VIEW.height * 0.3, VIEW.width / 2, VIEW.height / 2, VIEW.height * 0.8);
    g.addColorStop(0, 'rgba(120,0,20,0)');
    g.addColorStop(1, `rgba(150,0,25,${0.45 * a * (0.7 + Math.sin(t * 4) * 0.3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  }

  function draw(state, screen, extra) {
    t = state.clock;
    if (!state.player) return;
    if (screen === 'play' || screen === 'paused') {
      drawMinimap(state, state.player.x, state.player.y);
      drawPlayerHud(state);
      drawMissionMarkerOnScreen(state);
      drawBanner(state);
      drawToast(state);
      drawHurtVignette(state);
    }
    if (screen === 'paused') drawPause(state);
  }

  /* ---------------------------------------------------------------- screens */

  function drawTitle(state, best) {
    const p = state.player;
    // Dark glass over the living city.
    const g = ctx.createLinearGradient(0, 0, VIEW.width, VIEW.height);
    g.addColorStop(0, 'rgba(4,3,10,0.90)');
    g.addColorStop(0.55, 'rgba(8,6,20,0.72)');
    g.addColorStop(1, 'rgba(4,3,10,0.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);

    // Neon grid floor, faint.
    ctx.save();
    ctx.strokeStyle = 'rgba(80,200,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 22; i += 1) {
      const y = VIEW.height * 0.56 + (i * i) * 1.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(VIEW.width, y); ctx.stroke();
    }
    ctx.restore();

    // Title.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `800 96px ${FONT}`;
    ctx.shadowColor = C.neonMagenta;
    ctx.shadowBlur = 40;
    ctx.fillStyle = alpha(C.neonMagenta, 0.35);
    ctx.fillText('NEON', VIEW.width / 2 - 132, 262);
    ctx.shadowColor = C.neonCyan;
    ctx.fillStyle = alpha(C.neonCyan, 0.35);
    ctx.fillText('HAVEN', VIEW.width / 2 + 148, 262);
    ctx.shadowBlur = 0;
    ctx.fillStyle = C.text;
    ctx.fillText('NEON', VIEW.width / 2 - 132, 260);
    ctx.fillText('HAVEN', VIEW.width / 2 + 148, 260);
    // A hairline splitting the two halves.
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(VIEW.width / 2 - 24, 186);
    ctx.lineTo(VIEW.width / 2 - 24, 264);
    ctx.stroke();
    ctx.restore();

    label('A CRIME STORY IN FIVE NIGHTS', VIEW.width / 2, 296, 13, 'rgba(200,215,245,0.72)', 'center', 700, false, 5);
    label('The tide is coming in and every debt in the city is due. VEX has a car, a favour and no patience.', VIEW.width / 2, 326, 14, 'rgba(225,235,255,0.9)', 'center', 500);

    // Controls.
    const cx = VIEW.width / 2;
    const rows = [
      ['WASD', 'Walk / drive'],
      ['SHIFT', 'Sprint'],
      ['MOUSE + LMB', 'Aim / fire'],
      ['F', 'Enter / exit vehicle'],
      ['E', 'Melee · pick up'],
      ['1 2 3', 'Sidearm · SMG · shotgun'],
      ['ESC', 'Pause · save'],
    ];
    const top = 366;
    for (let i = 0; i < rows.length; i += 1) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = cx - 250 + col * 290;
      const y = top + row * 30;
      label(rows[i][0], x, y, 11, alpha(C.neonCyan, 0.95), 'left', 800, true, 1.2);
      label(rows[i][1], x + 108, y, 12, 'rgba(215,225,248,0.8)', 'left', 500);
    }

    // Prompt.
    const pulse = 0.55 + Math.sin(t * 3.2) * 0.45;
    label(best > 0 ? 'PRESS ENTER TO CONTINUE' : 'PRESS ENTER TO START', cx, 618, 18, alpha(C.neonAmber, pulse), 'center', 800, false, 4);
    if (best > 0) label('OR PRESS N FOR A NEW NIGHT', cx, 644, 11, 'rgba(210,225,255,0.55)', 'center', 700, false, 2.4);
    label('ORIGINAL CITY · ORIGINAL SCORE · GENERATED IN CANVAS', cx, 686, 9.5, 'rgba(150,170,210,0.42)', 'center', 600, false, 1.6);

    // Side captions: the factions.
    const sides = [
      { name: 'VEX', role: 'FIXER', col: C.neonMagenta, x: 120 },
      { name: 'MAMA SABLE', role: 'SALT MARKET', col: C.neonAmber, x: VIEW.width - 120 },
    ];
    for (const s of sides) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = s.col;
      ctx.fillRect(s.x - 26, 268, 52, 2);
      ctx.restore();
      label(s.name, s.x, 254, 10, alpha(s.col, 0.75), 'center', 800, false, 3);
      label(s.role, s.x, 288, 8.5, 'rgba(190,205,235,0.45)', 'center', 700, false, 2);
    }
  }

  function drawPause(state) {
    ctx.fillStyle = 'rgba(4,4,10,0.72)';
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    const cx = VIEW.width / 2;
    label('PAUSED', cx, 300, 54, C.text, 'center', 800, false, 8);
    label('THE CITY KEEPS BURNING WITHOUT YOU', cx, 336, 12, 'rgba(200,215,245,0.6)', 'center', 700, false, 3);
    label('ESC  RESUME', cx, 414, 15, alpha(C.neonCyan, 0.95), 'center', 700, false, 3);
    label('S  SAVE NIGHT', cx, 446, 15, alpha(C.neonAmber, 0.95), 'center', 700, false, 3);
    label('Q  ABANDON TO TITLE', cx, 478, 15, 'rgba(220,230,255,0.7)', 'center', 700, false, 3);
    label(`MONEY ${money(state.player.money)}   ·   MISSIONS ${state.missionIndex}/${state.missions ? state.missions.length : 5}`, cx, 530, 11, 'rgba(190,205,235,0.6)', 'center', 700, false, 1.6);
  }

  function drawDeath(state) {
    ctx.fillStyle = `rgba(60,0,12,${clamp(state.player.deadTimer / 2, 0, 0.55)})`;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    label('WASTED', VIEW.width / 2, VIEW.height / 2 - 10, 64, '#ff4d5e', 'center', 800, false, 12);
    label('THE HOSPITAL WILL SEND THE BILL', VIEW.width / 2, VIEW.height / 2 + 34, 12, 'rgba(255,210,220,0.7)', 'center', 700, false, 3);
  }

  return { draw, drawTitle, drawPause, drawDeath, drawMinimap, drawBanner };
}
