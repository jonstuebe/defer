import { isTrackingParam } from "./tracking-params.js";

export { isTrackingParam, TRACKING_PARAMS, TRACKING_PARAM_PREFIXES } from "./tracking-params.js";

export function canonicalize(input: string): string {
  const url = new URL(input);

  url.hash = "";
  url.username = "";
  url.password = "";

  for (const key of new Set(url.searchParams.keys())) {
    if (isTrackingParam(key)) {
      url.searchParams.delete(key);
    }
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
