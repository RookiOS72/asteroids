/* Asteroids — in-browser port.
 *
 * Single-file game loop. Vanilla JS, no framework. State machine:
 *   MENU → PLAYING → GAME_OVER → PLAYING (replay) | PLAYING (new field)
 *
 * First-Credit Replay: every run has a seed; replaying uses the same seed to
 * regenerate the same asteroid field. Original game is unchanged — the prompt
 * is opt-in.
 */

(() => {
  // ---- Canvas setup ----
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  // ---- HUD references ----
  const elScore = document.getElementById("score");
  const elLives = document.getElementById("lives");
  const elSeed = document.getElementById("seed");
  const elBest = document.getElementById("best");
  const elPhysics = document.getElementById("physics-toggle");
  const overlay = document.getElementById("overlay");
  const overlayInner = document.getElementById("start-screen");

  // ---- Game constants ----
  const SHIP_SIZE = 12;
  const SHIP_THRUST = 220; // px/s^2
  const SHIP_MAX_SPEED = 380; // px/s
  const SHIP_DRAG = 0.4; // per second (scaled)
  const SHIP_ROT_SPEED = 4.5; // rad/s
  const SHIP_FIRE_COOLDOWN = 0.18; // seconds
  const BULLET_SPEED = 460;
  const BULLET_LIFE = 0.85;
  const ASTEROID_SPEEDS = [60, 110, 160]; // large, medium, small
  const ASTEROID_SCORES = [20, 50, 100];
  const ASTEROID_SIZES = [44, 22, 11]; // radius
  const ASTEROID_VERTS_LARGE = 9;
  const ASTEROID_VERTS_MED = 7;
  const ASTEROID_VERTS_SMALL = 5;
  const UFO_BIG_INTERVAL = 12; // seconds
  const UFO_SMALL_INTERVAL = 7;
  const UFO_BIG_POINTS = 200;
  const UFO_SMALL_POINTS = 1000;
  const EXTRA_LIFE_SCORE = 10000;
  const SAFE_RESPAWN_TIME = 2.0; // seconds of invulnerability after death
  const HYPERSPACE_COOLDOWN = 1.0;

  // v0.2 toggle: do asteroids bounce off each other (realish physics)?
  // Default OFF so the replay-deterministic field stays byte-identical across
  // multiple plays of the same seed. ON = dynamic field that changes each
  // replay but feels more "alive". User-toggled via `A` key.
  let asteroidCollisions = false;

  // ---- Game state ----
  const STATE = { MENU: "menu", PLAYING: "playing", GAME_OVER: "game_over" };
  let state = STATE.MENU;

  let ship = null;
  let bullets = [];
  let asteroids = [];
  let ufos = [];
  let particles = []; // short-lived debris

  let score = 0;
  let lives = 3;
  let extraLifeAwarded = false;
  let currentSeed = 0;
  let currentBestOnSeed = null; // null = no prior best
  let level = 0; // increments per wave cleared; resets on new field AND on replay
  let elapsed = 0; // total seconds since game start (for UFO spawning)
  let ufoTimer = 0;
  let lastTime = 0;
  let respawnTimer = 0;
  let hyperspaceCooldown = 0;

  // Seed-bound RNG; reset to a fresh function whenever a new seed is used.
  let rand = null;

  // ---- Helpers ----

  function newAsteroid(sizeIdx, x, y, vx, vy) {
    // Generate a procedural shape for this asteroid so we don't store a global
    // shape table. Same seed => same shapes (deterministic via rand()).
    const vertCount = [ASTEROID_VERTS_LARGE, ASTEROID_VERTS_MED, ASTEROID_VERTS_SMALL][sizeIdx];
    const verts = [];
    for (let i = 0; i < vertCount; i++) {
      const a = (i / vertCount) * Math.PI * 2;
      const r = ASTEROID_SIZES[sizeIdx] * (0.7 + rand() * 0.5);
      verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return {
      size: sizeIdx,
      x: x ?? rand() * W,
      y: y ?? rand() * H,
      vx: vx ?? (rand() * 2 - 1) * ASTEROID_SPEEDS[sizeIdx],
      vy: vy ?? (rand() * 2 - 1) * ASTEROID_SPEEDS[sizeIdx],
      angle: rand() * Math.PI * 2,
      spin: (rand() * 2 - 1) * 1.5,
      verts,
    };
  }

  function spawnInitialField() {
    asteroids = [];
    // Count grows by one each wave cleared: level 0 = 4 large, level 1 = 5,
    // level N = 4+N. No cap — the field gets overwhelming over time and the
    // player survives as long as their skill holds. (This matches the OG
    // arcade, which had no upper limit on field density.) The level persists
    // across replays of the same seed so wave difficulty is reproducible.
    const count = 4 + level;
    for (let i = 0; i < count; i++) {
      const size = 0; // all large to start
      let x, y;
      // avoid spawning too close to center where the ship starts
      do {
        x = rand() * W;
        y = rand() * H;
      } while (Math.hypot(x - W / 2, y - H / 2) < 120);
      asteroids.push(newAsteroid(size, x, y));
    }
  }

  function newShip() {
    return {
      x: W / 2,
      y: H / 2,
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2, // pointing up
      thrusting: false,
      cooldown: 0,
      visible: true,
      invincible: SAFE_RESPAWN_TIME,
    };
  }

  // Clear a safe zone around the ship's spawn point so the player has room to
  // maneuver after respawn. Called on every ship creation (initial + after death).
  // Large asteroids split into 2 medium (their normal cascade), giving the player
  // a smaller, slower field to dodge. Mediums split into 2 smalls. Smalls just die.
  function clearSpawnZone() {
    const SAFE_RADIUS = 120;
    const surviving = [];
    for (const a of asteroids) {
      const d = Math.hypot(a.x - W / 2, a.y - H / 2);
      if (d < SAFE_RADIUS) {
        // Apply the normal cascade rule
        score += ASTEROID_SCORES[a.size];
        Audio.boom();
        if (a.size < 2) {
          for (let k = 0; k < 2; k++) {
            asteroids.push(newAsteroid(a.size + 1, a.x, a.y,
              (rand() * 2 - 1) * ASTEROID_SPEEDS[a.size + 1],
              (rand() * 2 - 1) * ASTEROID_SPEEDS[a.size + 1]));
          }
        }
        // small ones just disappear
      } else {
        surviving.push(a);
      }
    }
    asteroids = surviving;
  }

  function spawnDebris(x, y, count, color = "#ff6644") {
    // Random pixel-dot debris (used for asteroid/UFO explosions).
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const sp = 40 + rand() * 180;
      particles.push({
        type: "dot",
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + rand() * 0.4,
        maxLife: 0.8,
        color,
      });
    }
  }

  // Spawn ship wireframe segments as drifting debris. Each segment is a
  // line from (x1,y1) to (x2,y2) drawn in the ship's color, drifting in a
  // random direction with a slow rotation, fading over ~5 seconds. Matches
  // the OG Asteroids ship-death animation: the ship "disconnects" and the
  // line segments float away and fade independently.
  function spawnShipDebris(ship, color = "#ffffff") {
    // The ship's wireframe is 6 line segments forming the ship outline.
    // Ship local-space points (relative to ship center, before rotation):
    //   (1, 0), (-0.7, 0.7), (-0.4, 0), (-0.7, -0.7)
    // We construct the 4 actual line segments from these points.
    const S = SHIP_SIZE;
    const pts = [
      [S, 0],
      [-S * 0.7, S * 0.7],
      [S, 0],
      [-S * 0.4, 0],
      [-S * 0.4, 0],
      [-S * 0.7, S * 0.7],
      [-S * 0.4, 0],
      [-S * 0.7, -S * 0.7],
      [-S * 0.4, 0],
      [-S * 0.7, -S * 0.7],
    ];
    // Rotate the local points by the ship's current angle, then translate.
    const cos = Math.cos(ship.angle);
    const sin = Math.sin(ship.angle);
    for (let i = 0; i < pts.length; i += 2) {
      const [lx1, ly1] = pts[i];
      const [lx2, ly2] = pts[i + 1];
      const x1 = ship.x + lx1 * cos - ly1 * sin;
      const y1 = ship.y + lx1 * sin + ly1 * cos;
      const x2 = ship.x + lx2 * cos - ly2 * sin;
      const y2 = ship.y + lx2 * sin + ly2 * cos;
      // Each segment drifts in a random direction with a slow rotation.
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 80;
      particles.push({
        type: "segment",
        x1, y1, x2, y2,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        angle: 0,
        vAngle: (Math.random() - 0.5) * 4,
        life: 3.0 + Math.random() * 2.5,
        maxLife: 5.5,
        color,
      });
    }
  }

  function startGameWithSeed(seed, { resetLevel = false } = {}) {
    currentSeed = seed;
    rand = mulberry32(seed);
    score = 0;
    lives = 3;
    // Defensive: silence thrust audio in case the previous session was
    // thrusting when this game started (rare — only happens if a keydown
    // listener fires before update can process it). Cheap insurance.
    Audio.thrust(false);
    extraLifeAwarded = false;
    elapsed = 0;
    ufoTimer = UFO_BIG_INTERVAL;
    bullets = [];
    ufos = [];
    // Kill any persistent UFO audio from a previous run
    Audio.ufoActive(false);
    particles = [];
    // Reset level only when explicitly requested (new field, not replay).
    // Replay keeps the level the same seed had, so wave difficulty is reproducible.
    if (resetLevel) level = 0;
    ship = newShip();
    spawnInitialField();
    state = STATE.PLAYING;
    overlay.classList.add("hidden");
    document.querySelector(".stage")?.classList.remove("has-overlay");
    updateHud();
    // Start the background drone — runs continuously while playing.
    Audio.droneStart();
  }

  function gameOver() {
    state = STATE.GAME_OVER;
    // Stop the background drone — game over, no more menace.
    Audio.droneStop();
    // Stop thrust audio — same reason as killShip(). The player might have
    // been holding thrust when their final life ended.
    Audio.thrust(false);
    if (!extraLifeAwarded && score >= EXTRA_LIFE_SCORE) {
      // ensure extra-life rule fires before we check best
    }
    if (currentBestOnSeed === null || score > currentBestOnSeed) {
      currentBestOnSeed = score;
    }
    Audio.gameOver();
    showGameOverOverlay();
  }

  function showGameOverOverlay() {
    const isHigh = currentBestOnSeed === score;
    overlayInner.innerHTML = `
      <h1>GAME OVER</h1>
      <p class="prompt" id="score-final">SCORE: ${score.toLocaleString()}${isHigh ? " &middot; NEW BEST ON THIS SEED" : ""}</p>
      <p class="prompt" style="color:#aaa; font-size:0.7em;">SEED ${formatSeed(currentSeed)} &middot; BEST ${(currentBestOnSeed ?? 0).toLocaleString()}</p>
      <p class="hints" style="margin-top:2em;">
        <span><kbd>R</kbd> REPLAY THIS SEED</span>
        <span><kbd>N</kbd> NEW FIELD</span>
        <span><kbd>ESC</kbd> QUIT TO MENU</span>
      </p>
    `;
    overlay.classList.remove("hidden");
    document.querySelector(".stage").classList.add("has-overlay");
  }

  function showMenuOverlay() {
    overlayInner.innerHTML = `
      <h1>ASTEROIDS</h1>
      <p class="prompt">PRESS <kbd>SPACE</kbd> TO START</p>
      <p class="hints">
        <span><kbd>&larr;</kbd> <kbd>&rarr;</kbd> ROTATE</span>
        <span><kbd>&uarr;</kbd> THRUST</span>
        <span><kbd>SPACE</kbd> FIRE</span>
        <span><kbd>SHIFT</kbd> HYPERSPACE</span>
      </p>
      <p class="hints" style="margin-top:0.5em;">
        <span><kbd>R</kbd> REPLAY SEED (after death)</span>
        <span><kbd>N</kbd> NEW SEED</span>
        <span><kbd>M</kbd> MUTE</span>
      </p>
      <p class="meta">a browser port by Rook &middot; faithful mechanics + First-Credit Replay</p>
    `;
    overlay.classList.remove("hidden");
    document.querySelector(".stage").classList.add("has-overlay");
  }

  function updateHud() {
    elScore.textContent = `SCORE: ${score.toLocaleString()}`;
    elLives.textContent = `LIVES: ${lives}`;
    elSeed.textContent = `SEED: ${currentSeed ? formatSeed(currentSeed) : "—"}`;
    elBest.textContent = currentBestOnSeed !== null
      ? `BEST ON THIS SEED: ${currentBestOnSeed.toLocaleString()}`
      : "BEST ON THIS SEED: —";
    elPhysics.textContent = `PHYSICS: ${asteroidCollisions ? "COLLISIONS (A)" : "PASS-THROUGH (A)"}`;
    elPhysics.style.color = asteroidCollisions ? "#ffaa44" : "#666";
  }

  // ---- Input ----

  const keys = {};
  window.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "Space", "ShiftLeft", "ShiftRight"].includes(e.code)) {
      e.preventDefault();
    }
    keys[e.code] = true;

    // Audio context unlock (first key press)
    Audio.unlock();

    if (state === STATE.MENU) {
      if (e.code === "Space") {
        startGameWithSeed(newSeed(), { resetLevel: true });
      }
    } else if (state === STATE.GAME_OVER) {
      if (e.code === "KeyR") {
        startGameWithSeed(currentSeed, { resetLevel: true }); // replay: reset to wave 1
      } else if (e.code === "KeyN") {
        startGameWithSeed(newSeed(), { resetLevel: true });
      } else if (e.code === "Escape") {
        state = STATE.MENU;
        ship = null;
        Audio.droneStop();
        showMenuOverlay();
      }
    } else if (state === STATE.PLAYING) {
      if (e.code === "KeyM") {
        Audio.setMuted(!audioMuted);
        audioMuted = !audioMuted;
      }
      // Toggle asteroid-on-asteroid collisions (v0.2 experiment).
      // Press `A` any time during play to flip it on/off. The setting
      // resets to OFF on every new game (deterministic replay default).
      if (e.code === "KeyA" && !e.repeat) {
        asteroidCollisions = !asteroidCollisions;
        updateHud();
      }
    }
  });
  window.addEventListener("keyup", (e) => {
    keys[e.code] = false;
  });

  let audioMuted = false;

  // ---- Game loop ----

  function update(dt) {
    if (state !== STATE.PLAYING) return;
    elapsed += dt;

    // Ship
    if (ship) {
      ship.invincible = Math.max(0, ship.invincible - dt);
      ship.cooldown = Math.max(0, ship.cooldown - dt);
      hyperspaceCooldown = Math.max(0, hyperspaceCooldown - dt);

      if (keys.ArrowLeft) ship.angle -= SHIP_ROT_SPEED * dt;
      if (keys.ArrowRight) ship.angle += SHIP_ROT_SPEED * dt;
      const thrusting = !!keys.ArrowUp;
      if (thrusting !== ship.thrusting) {
        ship.thrusting = thrusting;
        Audio.thrust(thrusting);
      }
      if (thrusting) {
        ship.vx += Math.cos(ship.angle) * SHIP_THRUST * dt;
        ship.vy += Math.sin(ship.angle) * SHIP_THRUST * dt;
      }
      // Apply drag (lose some velocity each frame)
      ship.vx *= Math.pow(1 - SHIP_DRAG, dt);
      ship.vy *= Math.pow(1 - SHIP_DRAG, dt);
      // Cap speed
      const sp = Math.hypot(ship.vx, ship.vy);
      if (sp > SHIP_MAX_SPEED) {
        ship.vx = (ship.vx / sp) * SHIP_MAX_SPEED;
        ship.vy = (ship.vy / sp) * SHIP_MAX_SPEED;
      }
      ship.x = wrap(ship.x + ship.vx * dt, W);
      ship.y = wrap(ship.y + ship.vy * dt, H);

      if (keys.Space && ship.cooldown <= 0) {
        fireBullet();
      }

      if (keys.ShiftLeft || keys.ShiftRight) {
        if (hyperspaceCooldown <= 0) {
          // Random teleport
          ship.x = rand() * W;
          ship.y = rand() * H;
          ship.vx = 0;
          ship.vy = 0;
          ship.invincible = 0.5; // brief invuln after hyperspace
          hyperspaceCooldown = HYPERSPACE_COOLDOWN;
        }
      }
    }

    // Bullets — STRAIGHT LINE, no wrapping. In the OG Asteroids, bullets
    // disappear when they leave the screen. We used to wrap them (forgiving
    // player intent) but it caused projectiles to fly across the screen
    // multiple times and made the UFO/audio logic behave oddly. Let them
    // age out via life; the filter below removes them once life <= 0 OR
    // (since the position is unchanged once they leave the screen) they
    // simply fly off the edge.
    for (const b of bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
    }
    bullets = bullets.filter((b) => b.life > 0);

    // Asteroids
    for (const a of asteroids) {
      a.x = wrap(a.x + a.vx * dt, W);
      a.y = wrap(a.y + a.vy * dt, H);
      a.angle += a.spin * dt;
    }
    if (asteroidCollisions) {
      resolveAsteroidCollisions();
    }

    // Particles
    for (const p of particles) {
      if (p.type === "segment") {
        // Ship wireframe debris: drift linearly + rotate around midpoint
        // so the line endpoints appear to drift independently.
        p.x1 += p.vx * dt;
        p.y1 += p.vy * dt;
        p.x2 += p.vx * dt;
        p.y2 += p.vy * dt;
        p.angle += p.vAngle * dt;
      } else {
        // Dot debris: wrap so trails stay on screen.
        p.x = wrap(p.x + p.vx * dt, W);
        p.y = wrap(p.y + p.vy * dt, H);
      }
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);

    // UFOs
    ufoTimer -= dt;
    if (ufos.length === 0 && ufoTimer <= 0) {
      const dir = rand() < 0.5 ? -1 : 1;
      const y = 60 + rand() * (H - 120);
      const isSmall = rand() < 0.3;
      ufos.push({
        x: dir > 0 ? 0 : W,
        y,
        vx: dir * (isSmall ? 180 : 90),
        size: isSmall ? "small" : "big",
        changeDirAt: elapsed + 1 + rand() * 2,
        cooldown: 1.2,
      });
      // Wire the UFO's audio so the "wub-wub-wub" keeps playing for its lifetime.
      // Previously we only triggered a single blip on fire; now the UFO tone is
      // continuously amplitude-modulated while it's on screen.
      Audio.ufoSetSize(isSmall ? "small" : "big");
      Audio.ufoActive(true);
      ufoTimer = isSmall ? UFO_SMALL_INTERVAL + rand() * 2 : UFO_BIG_INTERVAL + rand() * 3;
    }
    for (const u of ufos) {
      // UFO does NOT wrap. It enters from one side, flies across, and exits.
      // The wrap on x previously teleported it back — that's why the UFO never
      // escaped and seemed to "live forever" in a weird zone.
      u.x += u.vx * dt;
      u.cooldown = Math.max(0, u.cooldown - dt);
      // Fire on a per-size cooldown (big: 0.8s, small: 0.6s).
      // Cooldown-based — deterministic-on-cooldown — rather than per-frame
      // random, because a seeded RNG could suppress firing for many seconds
      // if the sequence produced values above the threshold for too long.
      if (u.cooldown <= 0) {
        // Big UFO (slow, harmless to score) fires in a RANDOM direction —
        // matching the OG arcade behavior where the big UFO is a wandering
        // hazard, not a precision weapon. Small UFO (fast, high-value)
        // aims at the ship — it's the "smart" UFO you have to shoot fast.
        // Both fire on a tight cooldown (0.6–0.8s) so the screen gets
        // busy with projectiles, like the original.
        let dx, dy;
        if (u.size === "big") {
          // Random direction in any angle. Add some y-bias so the UFO
          // doesn't just orbit the screen — pure random feels weird in
          // practice; mild y-bias makes the bullets feel "thrown".
          const a = Math.random() * Math.PI * 2;
          dx = Math.cos(a);
          dy = Math.sin(a) * 0.7 + (Math.random() < 0.5 ? 0.3 : -0.3);
        } else {
          // Small UFO aims at the ship.
          dx = ship.x - u.x;
          dy = ship.y - u.y;
          const d = Math.hypot(dx, dy) || 1;
          dx /= d; dy /= d;
        }
        const sp = u.size === "small" ? 320 : 240;
        bullets.push({
          x: u.x, y: u.y,
          vx: dx * sp,
          vy: dy * sp,
          life: 1.2,
          fromUfo: true,
        });
        // Cooldown: small UFO fires faster (0.6s) than big UFO (0.8s).
        u.cooldown = u.size === "small" ? 0.6 : 0.8;
        Audio.ufoFire();
      }
    }
    // UFO leaves the screen → remove. Now reachable because we stopped wrapping.
    const prevCount = ufos.length;
    ufos = ufos.filter((u) => u.x > -50 && u.x < W + 50);
    // If the last UFO just left the screen, mute its audio so the wub-wub stops.
    if (prevCount > 0 && ufos.length === 0) {
      Audio.ufoActive(false);
    }

    // Collisions: bullets vs asteroids, bullets vs UFO, ship vs asteroid, ship vs UFO
    const newBullets = [];
    for (const b of bullets) {
      let hit = false;
      for (let i = asteroids.length - 1; i >= 0; i--) {
        const a = asteroids[i];
        if (Math.hypot(b.x - a.x, b.y - a.y) < ASTEROID_SIZES[a.size]) {
          hit = true;
          score += ASTEROID_SCORES[a.size];
          spawnDebris(a.x, a.y, 8 + a.size * 4, "#ddccaa");
          Audio.boom();
          if (a.size < 2) {
            // Large (0) → 2 medium (1); medium (1) → 2 small (2).
            // Small (2) → no split, just disappears.
            for (let k = 0; k < 2; k++) {
              asteroids.push(newAsteroid(a.size + 1, a.x, a.y,
                (rand() * 2 - 1) * ASTEROID_SPEEDS[a.size + 1],
                (rand() * 2 - 1) * ASTEROID_SPEEDS[a.size + 1]));
            }
          }
          asteroids.splice(i, 1);
          break;
        }
      }
      if (hit) continue;

      for (let i = ufos.length - 1; i >= 0; i--) {
        const u = ufos[i];
        // Only ship-fired bullets can destroy a UFO. UFO bullets are an
        // internal artifact of the UFO's own fire pattern — by design, a
        // UFO is only vulnerable to its adversary's (the ship's) weapons,
        // not its own projectiles. This also eliminates an entire class
        // of bug: a UFO bullet fired toward the ship when the ship is
        // behind the UFO used to catch up and self-destroy the UFO.
        if (b.fromUfo) continue;
        if (Math.hypot(b.x - u.x, b.y - u.y) < 18) {
          hit = true;
          score += u.size === "small" ? UFO_SMALL_POINTS : UFO_BIG_POINTS;
          spawnDebris(u.x, u.y, 20, "#ffaa66");
          Audio.boom();
          ufos.splice(i, 1);
          if (ufos.length === 0) Audio.ufoActive(false);
          break;
        }
      }
      if (hit) continue;
      newBullets.push(b);
    }
    bullets = newBullets;

    // Ship vs asteroid / ship vs UFO
    if (ship && ship.invincible <= 0) {
      for (let i = asteroids.length - 1; i >= 0; i--) {
        const a = asteroids[i];
        if (Math.hypot(ship.x - a.x, ship.y - a.y) < ASTEROID_SIZES[a.size] + SHIP_SIZE * 0.5) {
          killShip();
          return;
        }
      }
      for (let i = ufos.length - 1; i >= 0; i--) {
        const u = ufos[i];
        if (Math.hypot(ship.x - u.x, ship.y - u.y) < 22) {
          killShip();
          return;
        }
      }
      // Ship vs UFO bullet
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        if (b.fromUfo && Math.hypot(ship.x - b.x, ship.y - b.y) < 10) {
          killShip();
          return;
        }
      }
    }

    // Extra life
    if (!extraLifeAwarded && score >= EXTRA_LIFE_SCORE) {
      lives += 1;
      extraLifeAwarded = true;
      Audio.extraLife();
    }

    // Background drone throb rate depends on the number of active
    // objects on screen. More objects = faster throb. This is the
    // Jaws-style pulse that intensifies with field density.
    Audio.droneSetObjectCount(asteroids.length + bullets.length + ufos.length + (ship ? 1 : 0));

    // Wave clear?
    if (asteroids.length === 0) {
      // Advance difficulty: each cleared wave adds one large asteroid.
      // No cap — the field gets overwhelming over time and the player
      // survives as long as their skill holds. The level persists across
      // replays of the same seed so wave difficulty is reproducible.
      level++;
      spawnInitialField();
    }

    updateHud();
  }

  function fireBullet() {
    const tip = {
      x: ship.x + Math.cos(ship.angle) * SHIP_SIZE,
      y: ship.y + Math.sin(ship.angle) * SHIP_SIZE,
    };
    bullets.push({
      x: tip.x,
      y: tip.y,
      vx: Math.cos(ship.angle) * BULLET_SPEED + ship.vx * 0.3,
      vy: Math.sin(ship.angle) * BULLET_SPEED + ship.vy * 0.3,
      life: BULLET_LIFE,
      fromUfo: false,
    });
    ship.cooldown = SHIP_FIRE_COOLDOWN;
    Audio.fire();
  }

  function killShip() {
    if (!ship) return;
    // Ship explodes into its own wireframe segments — the OG behavior.
    // The lines detach from the ship, drift outward, rotate, and fade
    // independently over ~5 seconds. We also add a few small dot debris for
    // the "burn" effect of the explosion.
    spawnShipDebris(ship, "#ffffff");
    spawnDebris(ship.x, ship.y, 8, "#ffaa66");
    Audio.boom();
    // Explicitly stop thrust audio — the update loop gates thrust audio
    // updates on `if (ship)`, so without this the persistent oscillator
    // keeps playing until the player hits thrust again.
    Audio.thrust(false);
    ship = null;
    lives -= 1;
    if (lives < 0) {
      gameOver();
      return;
    }
    // respawn after brief delay
    respawnTimer = 1.0;
    setTimeout(() => {
      if (state === STATE.PLAYING && !ship) {
        // Clear any asteroids that have drifted into the spawn zone during the
        // respawn delay. Without this, the player can respawn into a rock and
        // die again before the invincibility timer expires (or feel frozen
        // because the ship is sandwiched between threats on first frame).
        clearSpawnZone();
        ship = newShip();
      }
    }, 1200);
  }

  function wrap(v, max) {
    if (v < 0) return v + max;
    if (v >= max) return v - max;
    return v;
  }

  // v0.2: Asteroid-on-asteroid collisions. Soft, minimally-perturbing
  // physics: when two asteroids overlap, separate them along the line
  // between their centers and reflect each one's velocity along that
  // normal. No spin transfer — angular effects are out of scope.
  //
  // Why minimal-perturbation: the wrap-around world means asteroids
  // touching the screen edge are valid candidates for collision with
  // asteroids on the opposite edge. We resolve collisions via the SHORTEST
  // distance (which may go across the wrap), then push apart along that
  // axis. After separation, we wrap positions back into [0, W/H].
  //
  // Trade-off: when ON, the field evolves differently each replay even
  // with the same seed, because floating-point drift accumulates. When OFF,
  // the field is byte-identical (the original behavior).
  //
  // Mass model: mass proportional to volume (size^3). Same-size collisions
  // are elastic (full momentum swap). Different-size collisions use a tuned
  // restitution per pair so the heavier body absorbs most of the impulse
  // while the lighter body rebounds at a fraction of its approach speed.
  const ASTEROID_MASS = [ASTEROID_SIZES[0] ** 3, ASTEROID_SIZES[1] ** 3, ASTEROID_SIZES[2] ** 3];

  // Per-pair restitution matrix (e=0 means bodies stick; e=1 means fully
  // elastic). Rows = asteroid A's size, cols = asteroid B's size.
  //   same-size: 1.0 (full elastic, swap velocities)
  //   cross-size: tuned so the LARGER body absorbs more of the impact
  //
  // Tuning rationale (three-tier hierarchy, not two-tier):
  //   same-size:      e=1.0  → bouncy billiards, full swap
  //   one-apart:      e=0.85 → mostly elastic, modest absorption
  //                    (large↔medium, medium↔small — but Brenden said
  //                    medium↔small felt too bouncy; tuned down to 0.55)
  //   two-apart:      e=0.15 → "pebble hits boulder", mostly absorbed
  //                    (small↔large — boulder absorbs most of the
  //                    impact, small barely rebounds)
  //
  // The asymmetric matrix is symmetric on transpose (a↔b is same as b↔a
  // for the purposes of collision response).
  const COLLISION_RESTITUTION = {
    0: { 0: 1.0,  1: 0.85, 2: 0.15 }, // large   [large, medium, small]
    1: { 0: 0.85, 1: 1.0,  2: 0.55 }, // medium  [large, medium, small]
    2: { 0: 0.15, 1: 0.55, 2: 1.0 },  // small   [large, medium, small]
  };

  function resolveAsteroidCollisions() {
    // Multiple passes: a single position-correction + impulse might still leave
    // asteroids overlapping (because the position push isn't exact in discrete time).
    // Iterating until no overlaps converge to a clean separation.
    const MAX_PASSES = 4;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let anyOverlap = false;
      for (let i = 0; i < asteroids.length; i++) {
        const a = asteroids[i];
        const ra = ASTEROID_SIZES[a.size];
        const ma = ASTEROID_MASS[a.size];
        for (let j = i + 1; j < asteroids.length; j++) {
          const b = asteroids[j];
          const rb = ASTEROID_SIZES[b.size];
          const mb = ASTEROID_MASS[b.size];

          // Shortest delta accounting for wrap-around
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          if (dx > W / 2) dx -= W;
          else if (dx < -W / 2) dx += W;
          if (dy > H / 2) dy -= H;
          else if (dy < -H / 2) dy += H;
          const distSq = dx * dx + dy * dy;
          const minDist = ra + rb;
          if (distSq >= minDist * minDist) continue;

          anyOverlap = true;
          const dist = Math.sqrt(distSq) || 0.001; // avoid divide-by-zero
          // Normal vector from a → b
          const nx = dx / dist;
          const ny = dy / dist;

          // Push apart equal-distance (each asteroid moves half the overlap).
          // Position fix is geometric; the velocity response below is where mass matters.
          const overlap = (minDist - dist) * 0.5;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          // Re-wrap after the push
          a.x = wrap(a.x, W);
          a.y = wrap(a.y, H);
          b.x = wrap(b.x, W);
          b.y = wrap(b.y, H);

          // Reflect velocities along the collision normal.
          // Relative velocity along normal: (vB - vA) · n
          // vn < 0 means the bodies are approaching along the normal.
          const dvx = b.vx - a.vx;
          const dvy = b.vy - a.vy;
          const vn = dvx * nx + dvy * ny;
          if (vn >= 0) continue; // already separating (might still be inside)

          // Mass-weighted inelastic collision with per-pair restitution.
          // Standard 1D collision along the contact normal:
          //   Impulse magnitude: J = -(1+e) * vn / (1/m_a + 1/m_b)
          //   v_a' = v_a - J*n / m_a    (a is pushed in +n direction)
          //   v_b' = v_b + J*n / m_b    (b is pushed in -n direction)
          // This conserves momentum and respects restitution simultaneously.
          // DO NOT name this variable `j` — it shadows the outer loop counter
          // `for (let j = i + 1; ...)` and triggers a temporal-dead-zone crash.
          const e = COLLISION_RESTITUTION[a.size][b.size];
          const impulseMag = -(1 + e) * vn / (1 / ma + 1 / mb);
          a.vx -= (impulseMag / ma) * nx;
          a.vy -= (impulseMag / ma) * ny;
          b.vx += (impulseMag / mb) * nx;
          b.vy += (impulseMag / mb) * ny;
        }
      }
      if (!anyOverlap) break;
    }
  }

  // ---- Render ----

  function drawShip() {
    if (!ship || !ship.visible) return;

    // Draw the protective shield FIRST (so the ship blinks over it).
    // The original Asteroids draws a clear ring of vector dots around the
    // ship during invincibility — blinks when the timer is almost up.
    if (ship.invincible > 0) {
      const SHIELD_RADIUS = SHIP_SIZE * 1.6;
      const SEGMENTS = 12;
      const fade = Math.min(1, ship.invincible / 1.0); // fade in the last second
      ctx.save();
      ctx.translate(ship.x, ship.y);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * fade})`;
      ctx.lineWidth = 1;
      // Draw an octagonal-ish vector shield ring, similar to OG.
      // Skip every other segment for the "broken line" aesthetic of the OG.
      const skip = Math.floor(ship.invincible * 8) % 2;
      ctx.beginPath();
      let first = true;
      for (let i = 0; i < SEGMENTS; i++) {
        if ((i + skip) % 2 === 0) continue;
        const a1 = (i / SEGMENTS) * Math.PI * 2;
        const a2 = ((i + 1) / SEGMENTS) * Math.PI * 2;
        ctx.moveTo(Math.cos(a1) * SHIELD_RADIUS, Math.sin(a1) * SHIELD_RADIUS);
        ctx.lineTo(Math.cos(a2) * SHIELD_RADIUS, Math.sin(a2) * SHIELD_RADIUS);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Blink the ship during invincibility (classic OG effect).
    const blink = ship.invincible > 0 && Math.floor(ship.invincible * 8) % 2 === 0;
    if (blink) return;

    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.angle);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(SHIP_SIZE, 0);
    ctx.lineTo(-SHIP_SIZE * 0.7, SHIP_SIZE * 0.7);
    ctx.lineTo(-SHIP_SIZE * 0.4, 0);
    ctx.lineTo(-SHIP_SIZE * 0.7, -SHIP_SIZE * 0.7);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    if (ship.thrusting) {
      // Flame
      ctx.save();
      ctx.translate(ship.x, ship.y);
      ctx.rotate(ship.angle);
      ctx.strokeStyle = "#ffaa44";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-SHIP_SIZE * 0.4, -SHIP_SIZE * 0.4);
      ctx.lineTo(-SHIP_SIZE * (0.9 + rand() * 0.6), 0);
      ctx.lineTo(-SHIP_SIZE * 0.4, SHIP_SIZE * 0.4);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawAsteroid(a) {
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.angle);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < a.verts.length; i++) {
      const v = a.verts[i];
      if (i === 0) ctx.moveTo(v.x, v.y);
      else ctx.lineTo(v.x, v.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawBullet(b) {
    if (b.fromUfo) {
      // UFO bullets: orange-tinted, larger radius so they're actually
      // visible at 240+ px/s. The original 2px dot was too small to spot
      // mid-flight on a black background — the user could hear the sound
      // but not see the projectile.
      ctx.fillStyle = "#ff7755";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
      // Add a faint glow so it reads as "projectile" not "noise pixel"
      ctx.fillStyle = "rgba(255, 119, 85, 0.35)";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawUfo(u) {
    const w = u.size === "small" ? 18 : 28;
    const h = u.size === "small" ? 8 : 12;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(u.x, u.y, w, h, 0, 0, Math.PI * 2);
    ctx.stroke();
    // bottom dome
    ctx.beginPath();
    ctx.moveTo(u.x - w * 0.5, u.y);
    ctx.lineTo(u.x - w * 0.3, u.y + h * 0.6);
    ctx.lineTo(u.x + w * 0.3, u.y + h * 0.6);
    ctx.lineTo(u.x + w * 0.5, u.y);
    ctx.stroke();
  }

  function drawParticles() {
    for (const p of particles) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a;
      if (p.type === "segment") {
        // Wireframe segment debris: line endpoints drift independently
        // because the segment rotates around its midpoint via vAngle.
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        const midX = (p.x1 + p.x2) / 2;
        const midY = (p.y1 + p.y2) / 2;
        const cos = Math.cos(p.angle);
        const sin = Math.sin(p.angle);
        const dx1 = p.x1 - midX;
        const dy1 = p.y1 - midY;
        const dx2 = p.x2 - midX;
        const dy2 = p.y2 - midY;
        ctx.beginPath();
        ctx.moveTo(midX + dx1 * cos - dy1 * sin, midY + dx1 * sin + dy1 * cos);
        ctx.lineTo(midX + dx2 * cos - dy2 * sin, midY + dx2 * sin + dy2 * cos);
        ctx.stroke();
      } else {
        // Pixel-dot debris (asteroid / UFO explosions).
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    // Phosphor-style black with subtle CRT-like fade for trails
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.fillRect(0, 0, W, H);

    for (const a of asteroids) drawAsteroid(a);
    for (const u of ufos) drawUfo(u);
    // Bullets drawn AFTER UFOs (and AFTER the ship, below) so a UFO bullet
    // firing directly out of the UFO is visible immediately — the UFO body
    // doesn't hide its own projectile under render order.
    for (const b of bullets) drawBullet(b);
    drawShip();
    drawParticles();
  }

  function loop(t) {
    if (!lastTime) lastTime = t;
    let dt = (t - lastTime) / 1000;
    lastTime = t;
    if (dt > 0.05) dt = 0.05; // cap on big stalls

    // Defensive: if update or render throws (e.g. transient math error,
    // undefined state), log it and continue the loop. Without this, a
    // single thrown error kills the rAF callback chain and the game
    // appears frozen — exactly the bug the mass-weighted test caught.
    try {
      update(dt);
      render();
    } catch (err) {
      console.error("Frame error (game continues):", err);
    }
    requestAnimationFrame(loop);
  }

  // ---- Boot ----
  showMenuOverlay();
  updateHud();
  requestAnimationFrame(loop);

  // Expose minimal test hooks for smoke tests.
  // These are no-ops in production and don't leak gameplay logic.
  // They let us deterministically trigger game-over and inspect state from
  // headless test harnesses without faking keypresses.
  if (typeof window !== "undefined") {
    // Cached at spawn-time so tests can compare without physics-drift.
    // Keyed by seed, populated each time spawnInitialField() runs.
    let lastSpawnSnapshot = null;
    const origSpawnInitialField = spawnInitialField;
    spawnInitialField = function () {
      origSpawnInitialField();
      lastSpawnSnapshot = asteroids.map((a) => ({
        x: a.x, y: a.y, vx: a.vx, vy: a.vy,
        size: a.size, angle: a.angle, spin: a.spin,
        verts: a.verts.map((v) => ({ x: v.x, y: v.y })),
      }));
    };

    window.__asteroids = {
      getState: () => state,
      getSeed: () => currentSeed,
      getAsteroidCount: () => asteroids.length,
      getAsteroidSnapshot: () =>
        asteroids.map((a) => ({
          x: a.x, y: a.y, vx: a.vx, vy: a.vy,
          size: a.size, angle: a.angle, spin: a.spin,
          verts: a.verts.map((v) => ({ x: v.x, y: v.y })),
        })),
      // Spawn-time snapshot — exact RNG output, no physics drift.
      getAsteroidSnapshotAtSpawn: () => lastSpawnSnapshot,
      getBestOnSeed: () => currentBestOnSeed,
      forceGameOver: () => {
        if (state === STATE.PLAYING) gameOver();
      },
      replay: () => {
        if (state === STATE.GAME_OVER) startGameWithSeed(currentSeed, { resetLevel: true }); // replay: reset to wave 1
      },
      newField: () => {
        if (state === STATE.GAME_OVER) startGameWithSeed(newSeed(), { resetLevel: true });
      },
      // Test hook: clear any asteroids within the spawn-zone radius, applying
      // the normal cascade rule (large → 2 medium, medium → 2 small, small → gone).
      clearSpawnZone: () => clearSpawnZone(),
      // Test hook: clear ALL asteroids without cascading. For test setup only.
      _clearAll: () => { asteroids.length = 0; },
      // Test hook: clear + inject in a single synchronous block so the
      // game loop's auto-respawn ("if length === 0, spawnInitialField()")
      // can't fire between clear and inject.
      _setupField: (injected) => {
        asteroids.length = 0;
        for (const a of injected) asteroids.push(a);
      },
      // Test hook: inject a list of asteroids directly into the field.
      // Used by tests to set up specific collision scenarios without depending
      // on RNG-driven spawn.
      _injectAsteroids: (list) => {
        for (const a of list) asteroids.push(a);
        return asteroids.length;
      },
      // Test hook: inject a UFO bullet directly. Used by the UFO self-kill
      // regression test to simulate the dangerous "UFO bullet fired at the ship
      // that's behind the UFO" scenario.
      _injectUfoBullet: (x, y, vx, vy) => {
        bullets.push({ x, y, vx, vy, life: 1.2, fromUfo: true });
        return bullets.length;
      },
      // Test hook: clear bullets without resetting the rest of game state.
      _clearBullets: () => { bullets.length = 0; },
      // Test hook: get current bullet count.
      _getBulletCount: () => bullets.length,
      // Test hook: get current bullet snapshot (positions, velocities, source).
      _getBulletSnapshot: () =>
        bullets.map((b) => ({
          x: b.x, y: b.y, vx: b.vx, vy: b.vy,
          fromUfo: b.fromUfo, life: b.life,
        })),
      // Test hook: get the current asteroid velocities for assertion in tests.
      _getAsteroidVelocities: () =>
        asteroids.map((a) => ({ vx: a.vx, vy: a.vy, x: a.x, y: a.y })),
      // Test hook: get the current asteroid positions (with sizes) — useful for
      // collision-state debugging.
      _getAsteroidPositions: () =>
        asteroids.map((a) => ({ x: a.x, y: a.y, size: a.size })),
      // Spawn a UFO immediately (test only). Returns the new UFO's initial state.
      _spawnUfo: (size = "big") => {
        const dir = rand() < 0.5 ? -1 : 1;
        const y = 60 + rand() * (H - 120);
        const u = {
          x: dir > 0 ? 0 : W,
          y,
          vx: dir * (size === "small" ? 180 : 90),
          size,
          changeDirAt: elapsed + 1 + rand() * 2,
          cooldown: 0,
        };
        ufos.push(u);
        return { x: u.x, y: u.y, vx: u.vx, size: u.size };
      },
      getUfoCount: () => ufos.length,
      // Inject a bullet at a known position pointing at a known asteroid,
      // then trigger the collision resolution by calling the collision logic.
      // Returns the new asteroid list (post-collision). Test-only.
      _simulateBulletHit: (idx) => {
        if (idx < 0 || idx >= asteroids.length) return null;
        const a = asteroids[idx];
        const before = asteroids.length;
        const beforeSizes = asteroids.map((x) => x.size);
        score += ASTEROID_SCORES[a.size];
        spawnDebris(a.x, a.y, 8 + a.size * 4, "#ddccaa");
        Audio.boom();
        if (a.size < 2) {
          for (let k = 0; k < 2; k++) {
            asteroids.push(newAsteroid(a.size + 1, a.x, a.y,
              (rand() * 2 - 1) * ASTEROID_SPEEDS[a.size + 1],
              (rand() * 2 - 1) * ASTEROID_SPEEDS[a.size + 1]));
          }
        }
        asteroids.splice(idx, 1);
        return {
          beforeCount: before,
          afterCount: asteroids.length,
          beforeSizes,
          afterSizes: asteroids.map((x) => x.size),
          hitSize: a.size,
        };
      },
    };
  }
})();
