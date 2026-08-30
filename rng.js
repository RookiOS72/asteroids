/* Deterministic seeded RNG.
 *
 * Why not Math.random()? Because First-Credit Replay needs to regenerate the
 * exact same asteroid field from a seed. Math.random is implementation-defined
 * and varies by browser, so we use a tiny seeded PRNG.
 *
 * Mulberry32: 32-bit state, ~2^32 period, fast, good enough for game fields.
 * Reference: https://stackoverflow.com/a/47593316 (public domain).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Convenience: build a fresh random seed in 0..2^32 - 1 */
function newSeed() {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

/* Format a seed as a 4-char hex string for display */
function formatSeed(seed) {
  return "0x" + (seed >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(-4);
}

/* Hex -> int; returns NaN if invalid */
function parseSeed(str) {
  const m = /^0x([0-9a-fA-F]+)$/.exec(str.trim());
  if (!m) return NaN;
  return parseInt(m[1], 16);
}
