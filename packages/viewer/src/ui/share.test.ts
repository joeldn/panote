import { describe, it, expect } from 'vitest';
import { buildShareUrls, SHARE_PLATFORMS } from './share.js';

const data = {
  url: 'https://panos.example/v/church',
  title: 'St Lawrence Church',
  text: 'A 360° tour',
};

describe('buildShareUrls', () => {
  it('builds an entry for every known platform', () => {
    const urls = buildShareUrls(data);
    for (const p of SHARE_PLATFORMS) {
      expect(urls[p.id]).toBeTruthy();
    }
  });

  it('url-encodes the shared link and title', () => {
    const urls = buildShareUrls(data);
    expect(urls.twitter).toContain(encodeURIComponent(data.url));
    expect(urls.twitter).toContain(encodeURIComponent(data.title));
  });

  it('targets the right hosts', () => {
    const urls = buildShareUrls(data);
    expect(urls.facebook).toContain('facebook.com');
    expect(urls.linkedin).toContain('linkedin.com');
    expect(urls.whatsapp).toContain('wa.me');
    expect(urls.reddit).toContain('reddit.com');
    expect(urls.email).toMatch(/^mailto:/);
  });

  it('falls back to an empty title without throwing', () => {
    const urls = buildShareUrls({ url: 'https://x.test' });
    expect(urls.twitter).toContain(encodeURIComponent('https://x.test'));
  });
});
