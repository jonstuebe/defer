export {
  createVault,
  persistVault,
  loadVault,
  defaultDeviceName,
  type CreatedVault,
  type LoadedVault,
} from "./create-vault.js";
export {
  makeMnemonicChallenge,
  verifyMnemonicAnswers,
  type MnemonicChallenge,
  type MnemonicVerificationResult,
} from "./verify-mnemonic.js";
export {
  restoreFromMnemonic,
  type RestorationStep,
  type RestoreFromMnemonicDeps,
  type RecoveryClaim,
} from "./restore-vault.js";
export { BIP39_WORDLIST, isBip39Word, suggestBip39Words } from "./bip39-wordlist.js";
