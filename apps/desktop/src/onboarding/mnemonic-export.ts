import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { bytesToBase64Url } from "../util/base64.js";

export type MnemonicExportInputs = {
  mnemonic: string;
  vaultIdBytes: Uint8Array;
};

/**
 * Pure-text export of the recovery mnemonic (PRD US #5). Writes the 24
 * words newline-separated with a 2-line header so the file remains
 * meaningful if the user opens it on a system without metadata.
 */
export function buildMnemonicTxt(input: MnemonicExportInputs): string {
  const words = input.mnemonic.trim().split(/\s+/);
  if (words.length !== 24) {
    throw new RangeError(`buildMnemonicTxt: expected 24 words, got ${words.length}`);
  }
  const vaultIdShort = bytesToBase64Url(input.vaultIdBytes).slice(0, 8);
  return [
    `Defer — Recovery mnemonic for vault ${vaultIdShort}…`,
    "Keep this somewhere safe. Anyone with these 24 words can recover your vault.",
    "",
    ...words.map((word, index) => `${(index + 1).toString().padStart(2, " ")}. ${word}`),
  ].join("\n");
}

/**
 * Generates a printable PDF of the recovery mnemonic (PRD US #5).
 *
 * Layout: A4 / Letter-compatible portrait page; 4 columns × 6 rows of
 * numbered words; header line with the short vault-id prefix; footer
 * with a one-line "anyone with these words" warning. Uses pdf-lib's
 * `StandardFonts.Helvetica` so the PDF is fully portable (no font
 * embedding needed). All bytes generated in-process — no network.
 */
export async function buildMnemonicPdf(input: MnemonicExportInputs): Promise<Uint8Array> {
  const words = input.mnemonic.trim().split(/\s+/);
  if (words.length !== 24) {
    throw new RangeError(`buildMnemonicPdf: expected 24 words, got ${words.length}`);
  }
  const vaultIdShort = bytesToBase64Url(input.vaultIdBytes).slice(0, 8);

  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 portrait
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const margin = 60;
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();

  page.drawText(`Defer — Recovery mnemonic`, {
    x: margin,
    y: pageHeight - margin,
    size: 22,
    font: helvBold,
    color: rgb(0, 0, 0),
  });
  page.drawText(`Vault ${vaultIdShort}…`, {
    x: margin,
    y: pageHeight - margin - 24,
    size: 12,
    font: helv,
    color: rgb(0.3, 0.3, 0.3),
  });
  page.drawText(`Keep these 24 words private. Anyone holding them can recover your vault.`, {
    x: margin,
    y: pageHeight - margin - 44,
    size: 10,
    font: helv,
    color: rgb(0.4, 0.4, 0.4),
  });

  // 4 columns × 6 rows = 24 cells.
  const gridTop = pageHeight - margin - 100;
  const gridLeft = margin;
  const cols = 4;
  const cellWidth = (pageWidth - 2 * margin) / cols;
  const cellHeight = 60;

  for (let i = 0; i < words.length; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = gridLeft + col * cellWidth;
    const cellY = gridTop - row * cellHeight;

    page.drawText((i + 1).toString().padStart(2, "0"), {
      x: cellX,
      y: cellY,
      size: 10,
      font: helv,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawText(words[i] ?? "", {
      x: cellX + 28,
      y: cellY,
      size: 14,
      font: mono,
      color: rgb(0, 0, 0),
    });
  }

  page.drawText("defer — a local-first read-later queue", {
    x: margin,
    y: margin / 2,
    size: 8,
    font: helv,
    color: rgb(0.6, 0.6, 0.6),
  });

  return doc.save();
}
