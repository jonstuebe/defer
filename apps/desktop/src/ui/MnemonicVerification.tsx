import { useMemo, useState } from "react";

import {
  makeMnemonicChallenge,
  verifyMnemonicAnswers,
  type MnemonicChallenge,
} from "../onboarding/verify-mnemonic.js";

type MnemonicVerificationProps = {
  mnemonic: string;
  /** Number of words to challenge the user on. PRD US #7 fixes this at 4. */
  challengeSize?: number;
  onVerified: () => void;
  onBack: () => void;
};

export function MnemonicVerification({
  mnemonic,
  challengeSize = 4,
  onVerified,
  onBack,
}: MnemonicVerificationProps) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const challenge: MnemonicChallenge = useMemo(
    () => makeMnemonicChallenge(words.length, challengeSize),
    [words.length, challengeSize],
  );

  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState<readonly number[]>([]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const map = new Map<number, string>();
    for (const position of challenge.positions) map.set(position, answers[position] ?? "");
    const result = verifyMnemonicAnswers(words, challenge, map);
    if (result.ok) {
      onVerified();
    } else {
      setWrong(result.wrongPositions);
    }
  }

  return (
    <div className="screen col">
      <h1>Verify your mnemonic</h1>
      <p>Type the word at each position to confirm you've saved it.</p>
      <form className="card col" onSubmit={handleSubmit}>
        <div className="verify-grid">
          {challenge.positions.map((position) => {
            const isWrong = wrong.includes(position);
            return (
              <Word
                key={position}
                position={position}
                value={answers[position] ?? ""}
                isWrong={isWrong}
                onChange={(value) => setAnswers((prev) => ({ ...prev, [position]: value }))}
              />
            );
          })}
        </div>
        {wrong.length > 0 ? (
          <p className="danger">
            One or more positions don't match. Double-check what you wrote down.
          </p>
        ) : null}
        <div className="row">
          <button className="secondary" type="button" onClick={onBack}>
            Show mnemonic again
          </button>
          <button type="submit">Verify</button>
        </div>
      </form>
    </div>
  );
}

type WordProps = {
  position: number;
  value: string;
  isWrong: boolean;
  onChange: (value: string) => void;
};

function Word({ position, value, isWrong, onChange }: WordProps) {
  return (
    <>
      <label htmlFor={`word-${position}`}>Word #{position}</label>
      <input
        id={`word-${position}`}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={isWrong ? { borderColor: "var(--danger)" } : undefined}
      />
    </>
  );
}
