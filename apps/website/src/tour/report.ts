import { CONTACT_EMAIL } from '../landing/content.js';

/** A mailto to report a tour, with its share link filled in. */
export const reportHref = (siteOrigin: string, slug: string): string => {
  const url = `${siteOrigin.replace(/\/+$/, '')}/s/${encodeURIComponent(slug)}`;
  const subject = 'Report a tour';
  const body = `Tour: ${url}\n\nWhat is wrong with it:\n`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};
