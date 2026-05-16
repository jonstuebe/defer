export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "igshid",
  "_ga",
  "yclid",
]);

export const TRACKING_PARAM_PREFIXES: readonly string[] = ["utm_"];

export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}
