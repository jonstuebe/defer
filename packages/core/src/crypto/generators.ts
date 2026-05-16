import { assertReady, sodium } from "./sodium.js";

const VAULT_KEY_BYTES = 32;
const DEVICE_ID_BYTES = 16;
const DEVICE_AUTH_TOKEN_BYTES = 32;

export function generateVaultKey(): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(VAULT_KEY_BYTES);
}

export function generateDeviceId(): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(DEVICE_ID_BYTES);
}

export function generateDeviceAuthToken(): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(DEVICE_AUTH_TOKEN_BYTES);
}
