/** Pure helpers for GuardedConfirmation, kept React-free so tests can call them directly. */

/** Case and surrounding spaces do not matter; the word itself must match exactly. */
export function guardPhraseMatches(typed: string, phrase: string): boolean {
  const expected = phrase.trim().toLowerCase();
  return expected.length > 0 && typed.trim().toLowerCase() === expected;
}

/** Fraction of the hold completed, clamped to 0..1. A zero or negative hold completes at once. */
export function holdProgress(elapsedMs: number, holdMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return holdMs > 0 ? 0 : 1;
  if (!Number.isFinite(holdMs) || holdMs <= 0) return 1;
  return Math.min(1, elapsedMs / holdMs);
}

/** Keys that start a keyboard hold on the final button. */
export function isHoldKey(key: string): boolean {
  return key === ' ' || key === 'Enter';
}
