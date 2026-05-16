import { z } from "zod";

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.

export const envelopeFields = {
  seq: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
};
