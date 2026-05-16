import { z } from "zod";
import { envelopeFields } from "./envelope.js";

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.

export const DeviceRegisteredSchema = z.object({
  type: z.literal("DeviceRegistered"),
  ...envelopeFields,
  data: z.object({
    deviceId: z.string().min(1),
    deviceName: z.string().min(1),
    // deviceType values are intentionally not pinned to an enum in the wire
    // schema — old clients must not reject events from newer device classes.
    deviceType: z.string().min(1),
    registeredAt: z.number().int().nonnegative(),
  }),
});
export type DeviceRegistered = z.infer<typeof DeviceRegisteredSchema>;

export const DeviceRevokedSchema = z.object({
  type: z.literal("DeviceRevoked"),
  ...envelopeFields,
  data: z.object({
    deviceId: z.string().min(1),
  }),
});
export type DeviceRevoked = z.infer<typeof DeviceRevokedSchema>;
