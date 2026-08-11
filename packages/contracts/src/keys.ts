export const encUser = (sub: string): string => encodeURIComponent(sub);

export const panoPrefix = (u: string, p: string): string => `panos/${encUser(u)}/${p}/`;
export const originalKey = (u: string, p: string): string => `${panoPrefix(u, p)}original`;
export const manifestKey = (u: string, p: string): string => `${panoPrefix(u, p)}manifest.json`;
export const configKey = (u: string, p: string): string => `${panoPrefix(u, p)}config.json`;
export const userPanosPrefix = (u: string): string => `panos/${encUser(u)}/`;
export const tourKey = (u: string, t: string): string => `tours/${encUser(u)}/${t}/tour.json`;

const OWNER_RE = /^panos\/([^/]+)\/([^/]+)\//;
export const parseOwnerFromKey = (key: string): { userId: string; panoId: string } | null => {
  const m = OWNER_RE.exec(key);
  return m ? { userId: decodeURIComponent(m[1]!), panoId: m[2]! } : null;
};
