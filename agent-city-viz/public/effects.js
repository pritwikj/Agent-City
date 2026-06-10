/* ===========================================================================
   effects.js — transient eye-candy particles, all drawn in WORLD coordinates:
     - dust puffs + welding sparks (generic on-site construction; the mix is
       keyed off the building, never the agent's tool — read vs edit look alike)
     - smoke + fire flicker (incidents on a construction site)
     - confetti + flash (building topped out)
   Capped pools; cheap circles/rects only.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;

  const particles = []; // { x, y, vx, vy, g, life, maxLife, size, color, type }
  const MAX_PARTICLES = 600;
  const smokeEmitters = new Map(); // key -> { x, y, until, nextAt }

  function push(p) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    particles.push(p);
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }

  // world position helpers take tile coords + z height
  function at(tx, ty, z) { return C.worldToScreen(tx, ty, z || 0); }

  function spawnDust(tx, ty) {
    const p0 = at(tx, ty, 0);
    for (let i = 0; i < 3; i++) {
      push({
        x: p0.x + rnd(-6, 6), y: p0.y + rnd(-2, 2),
        vx: rnd(-12, 12), vy: rnd(-22, -8), g: 18,
        life: 0, maxLife: rnd(0.5, 0.9), size: rnd(2, 4),
        color: '186,160,130', type: 'fade',
      });
    }
  }

  function spawnSparks(tx, ty, z) {
    const p0 = at(tx, ty, z);
    for (let i = 0; i < 5; i++) {
      push({
        x: p0.x, y: p0.y,
        vx: rnd(-40, 40), vy: rnd(-50, -5), g: 140,
        life: 0, maxLife: rnd(0.25, 0.5), size: rnd(1, 2),
        color: i % 2 ? '255,180,60' : '255,230,140', type: 'spark',
      });
    }
  }

  function spawnConfetti(tx, ty, z) {
    const p0 = at(tx, ty, z);
    for (let i = 0; i < 36; i++) {
      const hue = Math.floor(rnd(0, 360));
      push({
        x: p0.x + rnd(-10, 10), y: p0.y,
        vx: rnd(-55, 55), vy: rnd(-90, -30), g: 110,
        life: 0, maxLife: rnd(0.9, 1.6), size: rnd(2, 3.5),
        hue, type: 'confetti',
      });
    }
    // flash ring
    push({
      x: p0.x, y: p0.y, vx: 0, vy: 0, g: 0,
      life: 0, maxLife: 0.45, size: 6, color: '255,255,255', type: 'ring',
    });
  }

  /** Smoke column on an incident site for `durationMs` (keyed so re-incidents extend). */
  function startSmoke(key, tx, ty, z, durationMs) {
    const p0 = at(tx, ty, z);
    const now = performance.now();
    const e = smokeEmitters.get(key);
    if (e) {
      e.until = now + durationMs;
      e.x = p0.x; e.y = p0.y;
    } else {
      smokeEmitters.set(key, { x: p0.x, y: p0.y, until: now + durationMs, nextAt: 0 });
    }
  }

  function updateAndDraw(ctx, dt, now) {
    // emitters
    for (const [key, e] of smokeEmitters) {
      if (now > e.until) { smokeEmitters.delete(key); continue; }
      if (now >= e.nextAt) {
        e.nextAt = now + 90;
        push({
          x: e.x + rnd(-4, 4), y: e.y,
          vx: rnd(-4, 7), vy: rnd(-30, -18), g: -6,
          life: 0, maxLife: rnd(1.2, 2.2), size: rnd(4, 8),
          color: '90,90,95', type: 'smoke',
        });
        // fire flicker at the base
        if (Math.random() < 0.5) {
          push({
            x: e.x + rnd(-3, 3), y: e.y + rnd(-1, 1),
            vx: rnd(-3, 3), vy: rnd(-14, -6), g: 0,
            life: 0, maxLife: rnd(0.2, 0.4), size: rnd(2, 4),
            color: '255,120,40', type: 'fade',
          });
        }
      }
    }
    // particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = p.life / p.maxLife;
      if (p.type === 'ring') {
        ctx.strokeStyle = 'rgba(' + p.color + ',' + (0.8 * (1 - t)) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size + t * 40, (p.size + t * 40) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.type === 'confetti') {
        ctx.fillStyle = 'hsla(' + p.hue + ',85%,60%,' + (1 - t) + ')';
        ctx.fillRect(p.x, p.y, p.size, p.size * 0.7);
      } else if (p.type === 'smoke') {
        ctx.fillStyle = 'rgba(' + p.color + ',' + (0.35 * (1 - t)) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + t), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(' + p.color + ',' + (1 - t) + ')';
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
  }

  function clearEffects() {
    particles.length = 0;
    smokeEmitters.clear();
  }

  Object.assign(window.CITY, {
    fx: { spawnDust, spawnSparks, spawnConfetti, startSmoke, updateAndDraw, clearEffects },
  });
})();
