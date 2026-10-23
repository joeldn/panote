import { describe, expect, it } from 'vitest';

import { rateLimitKeyForIp } from './ip-key.js';

describe('rateLimitKeyForIp', () => {
  it('keeps an IPv4 address as is', () => {
    expect(rateLimitKeyForIp('198.51.100.7')).toBe('198.51.100.7');
    expect(rateLimitKeyForIp('unknown')).toBe('unknown');
  });

  it('keys a full IPv6 address on its /64', () => {
    expect(rateLimitKeyForIp('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
  });

  it.each([
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8:0:0:abcd::', '2001:db8:0:0::/64'],
    ['2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8:1::5:6:7', '2001:db8:1:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:192.0.2.1', '0:0:0:0::/64'],
  ])('expands "::" in %s', (ip, key) => {
    expect(rateLimitKeyForIp(ip)).toBe(key);
  });
});
