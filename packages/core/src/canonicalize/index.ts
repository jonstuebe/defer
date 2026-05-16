import { isTrackingParam } from "./tracking-params.js";

export { isTrackingParam, TRACKING_PARAMS, TRACKING_PARAM_PREFIXES } from "./tracking-params.js";

export function canonicalize(input: string): string {
  const url = new URL(input);

  url.hash = "";

  const keys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    keys.add(key);
  }
  for (const key of keys) {
    if (isTrackingParam(key)) {
      url.searchParams.delete(key);
    }
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  let result = url.toString();
  if (result.endsWith("?")) {
    result = result.slice(0, -1);
  }
  return result;
}
