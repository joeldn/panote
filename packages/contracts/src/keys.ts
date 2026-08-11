// Every segment derived from a caller-supplied id is run through this before
// being interpolated into a key, not just userId: an unencoded panoId or
// tourId containing "/" would silently add extra key segments, letting it
// collide with (or read as) a different prefix in the R2 layout than the one
// panoPrefix()/tourKey() intended. encUser was already doing this for
// userId; panoId and tourId get the exact same treatment here rather than a
// second, different validation scheme.
export const encUser = (sub: string): string => encodeURIComponent(sub);

export const panoPrefix = (u: string, p: string): string => `panos/${encUser(u)}/${encUser(p)}/`;
export const originalKey = (u: string, p: string): string => `${panoPrefix(u, p)}original`;
export const manifestKey = (u: string, p: string): string => `${panoPrefix(u, p)}manifest.json`;
export const configKey = (u: string, p: string): string => `${panoPrefix(u, p)}config.json`;
export const userPanosPrefix = (u: string): string => `panos/${encUser(u)}/`;
export const tourKey = (u: string, t: string): string =>
  `tours/${encUser(u)}/${encUser(t)}/tour.json`;

const OWNER_RE = /^panos\/([^/]+)\/([^/]+)\//;
export const parseOwnerFromKey = (key: string): { userId: string; panoId: string } | null => {
  const m = OWNER_RE.exec(key);
  return m ? { userId: decodeURIComponent(m[1]!), panoId: decodeURIComponent(m[2]!) } : null;
};
