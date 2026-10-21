// The rate-limit key for a client IP. IPv4 is used as is. An IPv6 client
// usually holds a whole /64 and can rotate through it at will, so a /128 key
// would be no limit at all: key on the first four hextets (the /64) instead.
export const rateLimitKeyForIp = (ip: string): string => {
  if (!ip.includes(':')) return ip;
  const [head = '', tail, ...rest] = ip.toLowerCase().split('::');
  // More than one '::' isn't an address; keep it as its own key.
  if (rest.length > 0) return ip;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two hextets wide.
  const width = (parts: string[]) => parts.length + (parts.at(-1)?.includes('.') ? 1 : 0);
  const zeros = tail === undefined ? 0 : Math.max(0, 8 - width(left) - width(right));
  const hextets = [...left, ...Array<string>(zeros).fill('0'), ...right];
  const prefix = hextets
    .slice(0, 4)
    .map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? h.replace(/^0+(?=.)/, '') : h));
  return `${prefix.join(':')}::/64`;
};
