/**
 * User-Agent tokens of the crawlers that fetch a shared link to build its preview card
 * (Open Graph / Twitter tags), plus the search engines that index tour pages. Matched as
 * case-insensitive substrings, so `Slackbot` covers `Slackbot-LinkExpanding` and
 * `Pinterest` covers `Pinterestbot`. iMessage sends a facebookexternalhit/Twitterbot UA
 * and Teams sends SkypeUriPreview, so both are covered. Previews built in the sharer's
 * own client (Signal) send a browser UA and can't be told apart; they get the human budget.
 */
export const LINK_PREVIEW_AGENTS = [
  // Meta: Facebook, Messenger, Instagram, iMessage's preview fetcher
  'facebookexternalhit',
  'facebookcatalog',
  'meta-externalagent',
  'meta-externalfetcher',
  'Facebot',
  'WhatsApp',
  'Twitterbot',
  'LinkedInBot',
  'Slackbot',
  'Slack-ImgProxy',
  'Discordbot',
  'TelegramBot',
  // Skype and Microsoft Teams
  'SkypeUriPreview',
  'Applebot',
  'Pinterest',
  'redditbot',
  'Embedly',
  'Iframely',
  // Matrix homeservers' URL previews
  'Synapse',
  'Discourse Forum Onebox',
  'kakaotalk-scrap',
  // Fediverse servers fetching a card for a post
  'Mastodon',
  'Pleroma',
  'Akkoma',
  'Misskey',
  // Bluesky's card fetcher
  'Cardyb',
  'vkShare',
  'Viber',
  'Snapchat',
  'Tumblr',
  'Zoombot',
  // Search engines: the tags are also the page's title and snippet
  'Googlebot',
  'Google-InspectionTool',
  'GoogleOther',
  'bingbot',
  'BingPreview',
  'DuckDuckBot',
  'YandexBot',
] as const;

const PATTERN = new RegExp(
  LINK_PREVIEW_AGENTS.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|'),
  'i',
);

/** Whether a request comes from a link-preview or search crawler, by its User-Agent. */
export const isLinkPreviewBot = (userAgent: string | null): boolean =>
  userAgent !== null && PATTERN.test(userAgent);
