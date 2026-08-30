# Smoke test for Asteroids

Run with: `python3 scripts/smoke_test.py`

This script:
  1. Spawns a headless browser via Playwright.
  2. Loads `index.html` from the local file system.
  3. Verifies the canvas is present, the start overlay is shown.
  4. Presses SPACE → verifies the game enters PLAYING state and asteroids spawn.
  5. Waits for the player to die (or force-ends the game).
  6. Verifies the game-over overlay shows the seed + replay prompt.
  7. Presses R → verifies a new run starts with the SAME seed (asteroids in the same positions).
  8. Presses N → verifies a new run starts with a DIFFERENT seed.
  9. Prints a final pass/fail summary.

If Playwright is not installed, the script falls back to a Node-based check
that asserts the JS source files parse cleanly and contain the expected exports.

Requirements:
  - `pip install playwright pytest-playwright && playwright install chromium`
  - OR: `node` v18+ for the fallback check.

Exit code: 0 on full pass, 1 on any failure.
