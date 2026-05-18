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
