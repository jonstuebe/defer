import sodium from "libsodium-wrappers-sumo";

export const ready: Promise<void> = sodium.ready;

export { sodium };
