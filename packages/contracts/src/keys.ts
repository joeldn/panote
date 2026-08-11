// Every segment derived from a caller-supplied id is run through this before
// being interpolated into a key, not just userId: an unencoded panoId or
// tourId containing "/" would silently add extra key segments, letting it
// collide with (or read as) a different prefix in the R2 layout than the one
// panoPrefix()/tourKey() intended. encUser was already doing this for
// userId; panoId and tourId get the exact same treatment here rather than a
// second, different validation scheme.
export const encUser = (sub: string): string => encodeURIComponent(sub);

// The exact inverse of encUser, kept in this module so encode and decode of a
// key segment never drift apart. Callers that read a raw key segment back out
// of R2 (e.g. listChildren()'s output) must run it through decUser before
// handing it back to anything that will re-encode it - otherwise a
// caller-supplied id containing a URL-significant character survives one
// round trip encoded and is double-encoded on the next.
export const decUser = (s: string): string => decodeURIComponent(s);

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
  return m ? { userId: decUser(m[1]!), panoId: decUser(m[2]!) } : null;
};
