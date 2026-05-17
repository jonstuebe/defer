export type MnemonicChallenge = {
  /** 1-indexed word positions, sorted ascending, length 4. */
  positions: readonly number[];
};

export type MnemonicVerificationResult =
  | { ok: true }
  | { ok: false; wrongPositions: readonly number[] };

/**
 * Picks four distinct 1-indexed positions over a 24-word mnemonic.
 *
 * Caller supplies a random source so tests can pin output. In production
 * `Math.random` is acceptable here — the challenge is a usability gate, not
 * a security primitive (the user already has the mnemonic on screen at this
 * point in onboarding; the challenge defends against the user skipping the
 * "did I actually write this down" step, per PRD US #7).
 */
export function makeMnemonicChallenge(
  wordCount: number,
  challengeSize: number,
  rng: () => number = Math.random,
): MnemonicChallenge {
  if (wordCount < challengeSize) {
    throw new RangeError(
      `makeMnemonicChallenge: wordCount (${wordCount}) must be >= challengeSize (${challengeSize})`,
    );
  }
  const picked = new Set<number>();
  // Fisher–Yates-ish without materialising the full pool: keep drawing until
  // we have `challengeSize` distinct positions. `wordCount >= challengeSize`
  // means termination is guaranteed.
  while (picked.size < challengeSize) {
    const index = Math.floor(rng() * wordCount) + 1;
    picked.add(index);
  }
  return { positions: [...picked].sort((a, b) => a - b) };
}

/**
 * Verifies the user typed the right word for every position in the
 * challenge. Returns the subset of positions where the answer was wrong (or
 * blank) so the UI can highlight them inline.
 *
 * The mnemonic and answers must both be NFKD-normalised by the caller (or
 * by the caller passing already-normalised strings from the mnemonic
 * display). Whitespace differences inside an answer are stripped before
 * comparison so accidental leading/trailing spaces don't fail the gate.
 */
export function verifyMnemonicAnswers(
  mnemonicWords: readonly string[],
  challenge: MnemonicChallenge,
  answersByPosition: ReadonlyMap<number, string>,
): MnemonicVerificationResult {
  const wrong: number[] = [];
  for (const position of challenge.positions) {
    const expected = mnemonicWords[position - 1];
    const supplied = answersByPosition.get(position);
    if (
      expected === undefined ||
      supplied === undefined ||
      supplied.trim().toLowerCase() !== expected.trim().toLowerCase()
    ) {
      wrong.push(position);
    }
  }
  return wrong.length === 0 ? { ok: true } : { ok: false, wrongPositions: wrong };
}
