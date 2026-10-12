import { describe, expect, it } from 'vitest';

import { isLinkPreviewBot, LINK_PREVIEW_AGENTS } from './bots.js';

// Real User-Agent strings, as each crawler documents or sends them.
const CRAWLERS: [string, string][] = [
  ['Facebook', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
  ['Facebook catalog', 'facebookcatalog/1.0'],
  ['Facebot', 'Facebot'],
  [
    'Meta agent',
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  ],
  [
    'Meta fetcher',
    'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  ],
  ['Slack image proxy', 'Slack-ImgProxy (+https://api.slack.com/robots)'],
  ['Matrix (Synapse)', 'Synapse (bot; +https://github.com/matrix-org/synapse)'],
  ['Discourse', 'Discourse Forum Onebox v3.3.0'],
  ['KakaoTalk', 'facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/'],
  ['GoogleOther', 'Mozilla/5.0 (compatible; GoogleOther)'],
  [
    'Bing preview',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0 BingPreview/1.0b',
  ],
  ['WhatsApp', 'WhatsApp/2.23.20.0 A'],
  ['Twitter / X', 'Twitterbot/1.0'],
  [
    'LinkedIn',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  ],
  ['Slack', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
  ['Slack (plain)', 'Slackbot 1.0 (+https://api.slack.com/robots)'],
  ['Discord', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
  ['Telegram', 'TelegramBot (like TwitterBot)'],
  [
    'Teams / Skype',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com',
  ],
  [
    'Applebot',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  ],
  ['Pinterest', 'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)'],
  [
    'Reddit',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.116 Safari/537.36 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)',
  ],
  ['Embedly', 'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)'],
  ['Iframely', 'Iframely/1.3.1 (+https://iframely.com/docs/about) Atlassian'],
  ['Mastodon', 'http.rb/5.1.1 (Mastodon/4.2.1; +https://mastodon.social/)'],
  ['Pleroma', 'Pleroma 2.5.0; https://pleroma.example <admin@pleroma.example>'],
  ['Akkoma', 'Akkoma 3.10.4; https://akkoma.example <admin@akkoma.example>'],
  ['Misskey', 'Misskey/2023.12.2 (https://misskey.io)'],
  ['Bluesky', 'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)'],
  ['VK', 'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)'],
  ['Viber', 'Viber/20.3.0 CFNetwork/1410.0.3 Darwin/22.6.0'],
  ['Snapchat', 'Mozilla/5.0 (compatible; Snapchat/12.0; +https://www.snapchat.com)'],
  ['Tumblr', 'Tumblr/14.0.835'],
  ['Zoom', 'Zoombot'],
  [
    'Googlebot',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ],
  ['Google Search Console', 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)'],
  ['Bing', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['DuckDuckGo', 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)'],
  ['Yandex', 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)'],
];

const PEOPLE: [string, string | null][] = [
  [
    'Chrome on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ],
  [
    'Safari on iPhone',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ],
  ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'],
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  ],
  [
    'Chrome on Android',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  ],
  ['curl', 'curl/8.7.1'],
  ['no User-Agent', null],
  ['an empty User-Agent', ''],
];

describe('isLinkPreviewBot', () => {
  it.each(CRAWLERS)('knows %s', (_name, ua) => {
    expect(isLinkPreviewBot(ua)).toBe(true);
  });

  it.each(PEOPLE)('treats %s as a person', (_name, ua) => {
    expect(isLinkPreviewBot(ua)).toBe(false);
  });

  it('ignores case', () => {
    expect(isLinkPreviewBot('TWITTERBOT/1.0')).toBe(true);
    expect(isLinkPreviewBot('slackbot-linkexpanding 1.0')).toBe(true);
  });

  it('has a sample User-Agent for every token in the list', () => {
    for (const token of LINK_PREVIEW_AGENTS) {
      const hit = CRAWLERS.some(([, ua]) => ua.toLowerCase().includes(token.toLowerCase()));
      expect(hit, token).toBe(true);
    }
  });
});
