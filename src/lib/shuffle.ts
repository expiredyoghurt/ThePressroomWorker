// Deterministic, seed-based shuffling so a page refresh mid-attempt shows the
// same order, but every new attempt gets a fresh one. Never depends on
// Math.random() — the whole point is reproducibility from a stored seed.

// mulberry32: small, fast, good-enough PRNG for shuffling (not cryptographic —
// doesn't need to be, since the seed itself is a cryptographically random token).
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedToInt(seed: string): number {
  // simple string hash -> 32-bit int, good enough to seed mulberry32
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return h;
}

/** Fisher-Yates shuffle, deterministic from `seed`. Returns a NEW array of indices
 * into the original array, i.e. shuffled[i] = original[indices[i]]. Returning the
 * index mapping (not the shuffled values) is what lets the submit handler map
 * answers back to the true correct_index without re-sending the answer key. */
export function shuffledIndices(length: number, seed: string, salt: string): number[] {
  const rng = mulberry32(seedToInt(seed + ":" + salt));
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

export function applyShuffle<T>(arr: T[], indices: number[]): T[] {
  return indices.map((i) => arr[i]);
}

/** Given the original correct_index and the shuffle applied to the options array,
 * find where the correct option ended up (for building the client-facing payload
 * — the client never receives correct_index, only sees shuffled option text). */
export function newPositionOf(originalIndex: number, indices: number[]): number {
  return indices.indexOf(originalIndex);
}

/** Inverse: given the position the pupil clicked (in shuffled order) and the same
 * indices mapping, recover which original option that was — used at grading time. */
export function originalPositionOf(shuffledPosition: number, indices: number[]): number {
  return indices[shuffledPosition];
}
