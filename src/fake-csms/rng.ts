import { createHash } from 'node:crypto';

// Seeded randomness for the fake vendor, so a run (and a test) can be replayed.

// mulberry32: small, fast, good enough for simulation.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: (string | number)[]): number {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

export function hash01(s: string): number {
  return hashSeed(s) / 2 ** 32;
}
