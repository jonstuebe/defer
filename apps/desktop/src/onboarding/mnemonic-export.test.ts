import { describe, expect, it } from "vitest";

import { buildMnemonicPdf, buildMnemonicTxt } from "./mnemonic-export.js";

const fixtureVaultId = new Uint8Array(16).fill(0x12);
const fixtureMnemonic =
  "abandon ability able about above absent absorb abstract absurd abuse access accident " +
  "account accuse achieve acid acoustic acquire across act action actor actress actual";

describe("buildMnemonicTxt", () => {
  it("renders 24 numbered words + header", () => {
    const txt = buildMnemonicTxt({
      mnemonic: fixtureMnemonic,
      vaultIdBytes: fixtureVaultId,
    });
    const lines = txt.split("\n");
    // Header (2 lines) + blank + 24 word lines = 27.
    expect(lines.length).toBe(27);
    expect(lines[0]).toContain("Defer");
    expect(lines[3]).toContain("abandon");
    expect(lines[26]).toContain("actual");
  });

  it("rejects a mnemonic that isn't 24 words", () => {
    expect(() =>
      buildMnemonicTxt({ mnemonic: "abandon abandon", vaultIdBytes: fixtureVaultId }),
    ).toThrow(/24 words/);
  });
});

describe("buildMnemonicPdf", () => {
  it("produces a non-empty PDF byte stream starting with the PDF magic", async () => {
    const bytes = await buildMnemonicPdf({
      mnemonic: fixtureMnemonic,
      vaultIdBytes: fixtureVaultId,
    });
    expect(bytes.length).toBeGreaterThan(1000);
    const magic = new TextDecoder().decode(bytes.slice(0, 4));
    expect(magic).toBe("%PDF");
  });

  it("rejects a mnemonic that isn't 24 words", async () => {
    await expect(
      buildMnemonicPdf({ mnemonic: "abandon abandon", vaultIdBytes: fixtureVaultId }),
    ).rejects.toThrow(/24 words/);
  });
});
