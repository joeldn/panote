// Social-share controls. The URL building is pure (and unit-tested); the popover
// and button are thin DOM wrappers on top of it. The native Web Share sheet is
// used when available (mostly mobile); otherwise we open a per-platform popover.

export interface ShareData {
  /** Link to share. Defaults to the current page URL at mount time. */
  url?: string;
  /** Headline used by platforms that accept one. */
  title?: string;
  /** Longer blurb for platforms that accept body text. */
  text?: string;
}

export interface SharePlatform {
  id: string;
  label: string;
  /** Inline SVG markup for the platform glyph. */
  icon: string;
}

export const SHARE_PLATFORMS: readonly SharePlatform[] = [
  {
    id: 'twitter',
    label: 'X',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7.3 8.3L23 22h-6.8l-5.3-6.9L4.8 22H1.7l7.8-8.9L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.7L7.4 3.8H5.6L17.7 20Z"/></svg>',
  },
  {
    id: 'facebook',
    label: 'Facebook',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.300000000000001c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12Z"/></svg>',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm6 0h3.8v1.7h.1c.5-1 1.8-2 3.7-2 4 0 4.7 2.6 4.7 6V21h-4v-5.3c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9V21H9V9Z"/></svg>',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20Zm4.4-6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.1-.2 0-.4.1-.5l.4-.5.2-.4v-.4l-.7-1.7c-.2-.5-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1.1 2.7 1.6 2.5 3.5 3.3 5 3.7 1.5.4 1.7.3 2 .3.4-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1Z"/></svg>',
  },
  {
    id: 'reddit',
    label: 'Reddit',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12c0-1.2-1-2.2-2.2-2.2-.6 0-1.1.2-1.5.6a8.7 8.7 0 0 0-4.5-1.4l.8-3.6 2.5.6a1.5 1.5 0 1 0 .2-1l-3-.7a.5.5 0 0 0-.6.4l-.9 4.3a8.7 8.7 0 0 0-4.6 1.4 2.2 2.2 0 1 0-2.4 3.6 4 4 0 0 0 0 .5c0 2.9 3.3 5.2 7.5 5.2s7.5-2.3 7.5-5.2v-.5c.7-.4 1.2-1.1 1.2-2Zm-13 1.5a1.2 1.2 0 1 1 2.4 0 1.2 1.2 0 0 1-2.4 0Zm7.5 3.3c-.9.9-2.7 1-3.2 1s-2.3-.1-3.2-1a.4.4 0 0 1 .6-.5c.6.5 1.7.7 2.6.7s2-.2 2.6-.7a.4.4 0 0 1 .6.5Zm-.2-2.1a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"/></svg>',
  },
  {
    id: 'email',
    label: 'Email',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  },
] as const;

export function buildShareUrls(data: ShareData): Record<string, string> {
  const url = encodeURIComponent(data.url ?? '');
  const title = encodeURIComponent(data.title ?? '');
  const text = encodeURIComponent(data.text ?? data.title ?? '');
  return {
    twitter: `https://twitter.com/intent/tweet?url=${url}&text=${title}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    whatsapp: `https://wa.me/?text=${title}%20${url}`,
    reddit: `https://www.reddit.com/submit?url=${url}&title=${title}`,
    email: `mailto:?subject=${title}&body=${text}%0A%0A${url}`,
  };
}
