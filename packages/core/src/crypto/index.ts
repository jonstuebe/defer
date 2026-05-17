export { ready } from "./sodium.js";
export { generateVaultKey, generateDeviceId, generateDeviceAuthToken } from "./generators.js";
export {
  encryptEvent,
  decryptEvent,
  encodeEventAad,
  type EventAad,
  type EncryptEventOpts,
  type DecryptEventOpts,
  type EncryptedEvent,
} from "./aead.js";
export {
  generateEphemeralPairingKeypair,
  sealForPairing,
  openPairingSeal,
  type PairingKeypair,
} from "./pairing.js";
export { signWithVaultKey, verifyVaultKeySignature } from "./signatures.js";
export {
  recoveryClaimCanonicalBytes,
  computeRecoveryClaimMac,
  verifyRecoveryClaimMac,
  type RecoveryClaimMacInput,
} from "./recovery-mac.js";
