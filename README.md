# Asteroids — in-browser port by Rook

> **Faithful mechanics + First-Credit Replay.** The 1979 arcade classic in your browser tab, with the missing feature nobody built: replay the same field to actually beat your high score.

## Try it in your browser

**🕹️ [rookios72.github.io/asteroids](https://rookios72.github.io/asteroids/)** — click and play, no download needed.

## Play locally

Open `index.html` in any modern browser. No build step, no server, no install.

```bash
# from this directory:
open index.html         # macOS
xdg-open index.html     # Linux
start index.html        # Windows
```

Or just double-click the file.

## Controls

| Key | Action |
|---|---|
| `←` `→` | Rotate ship |
| `↑` | Thrust |
| `Space` | Fire |
| `Shift` | Hyperspace (random teleport; 1s cooldown) |
| `R` | (after death) Replay the same asteroid field |
| `N` | Start a new field |
| `M` | Mute / unmute audio |
| `A` | Toggle asteroid-on-asteroid collisions (v0.2) |
| `Esc` | Quit to title |

## What's in v0.2

- Newtonian ship physics with momentum, drag, screen-wrap
- Asteroids that split into smaller rocks (large → medium → small)
- Both UFOs (big, slow, low-value; small, fast, high-value)
- Score, lives, extra-life at 10,000
- Vector graphics on a black field, WebAudio synthesized sounds
- Keyboard controls
- Respawn shield: 2 seconds of invincibility + a clear zone around the respawn position
- Protective shield ring drawn during invincibility (visible "you are protected" indicator)
- Best-on-seed tracking (per browser session)

## What's *new*: First-Credit Replay (the headline innovation)

In the original arcade, every game-over meant a fresh random field — so your "high score" was a number you achieved once on a layout you'd never see again.

This port adds an opt-in replay: when you die, you'll see:

```
GAME OVER
SCORE: 17,420  ·  NEW BEST ON THIS SEED
SEED 0x8421  ·  BEST 22,180
─────────────────────────────────────
   R    REPLAY THIS SEED
   N    NEW FIELD
   ESC  QUIT TO MENU
```

Press **R** to play the *same* asteroid field again — same count, same positions, same starting velocities, byte-identical down to floating point. Your best on each seed is remembered (per browser session). This is the *only* persistent mechanic change; everything else matches the 1979 arcade feel.

## What's *new* in v0.2: size-aware asteroid collisions (opt-in)

Press **`A`** during play to toggle asteroid-on-asteroid collisions. Default is **OFF** (pass-through, byte-identical replay). When **ON**, asteroids bounce off each other with size-aware physics.

**Tunable three-tier hierarchy** (tuned by feel, not physical correctness):

| Collision pair | Restitution | Feel |
|---|---|---|
| Same-size | 1.00 | Bouncy billiards — full momentum swap |
| Large ↔ Medium | 0.85 | Mostly elastic — clear transfer, both bounce |
| Medium ↔ Small | 0.55 | Pebble-and-rock — small loses most of its energy |
| Small ↔ Large | 0.15 | "Pebble hits boulder" — small barely rebounds, large absorbs |

Math: mass is proportional to size³ (large = 85184, medium = 10648, small = 1331). Adjacent sizes are 8:1 mass ratio; large/small is 64:1. Heavier bodies get more impulse, lighter bodies get less — proper mass-weighted conservation of momentum.

**Trade-off:** with collisions ON, replay determinism applies only to the *initial* field. Once collisions start, the field evolves differently each play because floating-point drift accumulates. Same seed → same *starting* field, different mid-game.

**Try it:** turn it on, fire a few shots, watch the clusters spread. Toggle off to compare against OG behavior.

## What's NOT in v0.2

Deferred to v0.3+:

- Two-player mode
- Touch / mobile controls
- High-score leaderboard (would require a backend)
- Saved run history across browser sessions
- Settings menu (volume, controls remapping)
- Particle polish, CRT shader
- Seed sharing via URL (data is captured but no share button yet)

## Tech

- Vanilla JavaScript, no framework, no build step
- HTML5 Canvas for rendering
- WebAudio for synthesized sound (no audio files)
- Mulberry32 PRNG for deterministic seeded RNG
- Local-only (no analytics, no network requests, no accounts)

## Files

- `index.html` — page shell + HUD
- `style.css` — black-void minimal style
- `rng.js` — deterministic seeded RNG (Mulberry32)
- `audio.js` — WebAudio sound synthesis
- `game.js` — game loop, physics, state, replay, collision resolution
- `scripts/smoke_test.py` — Playwright end-to-end test (8 suites, 17+ assertions)

## Test coverage

The smoke test verifies all the things that would be embarrassing to ship broken: canvas renders, RNG is deterministic, replay is byte-identical, asteroid cascade splits correctly, UFOs escape the screen, audio module doesn't throw, respawn safety clears the spawn zone, the protective shield draws during invincibility, and the collision toggle works for all 6 size pairs with the right hardcoded restitution.

## License

MIT. By [Rook](https://github.com/RookiOS72).

