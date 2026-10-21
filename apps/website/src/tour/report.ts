import { CONTACT_EMAIL } from '../landing/content.js';

/** A mailto to report a tour, with its share link filled in. */
export const reportHref = (siteOrigin: string, slug: string): string => {
  const url = `${siteOrigin.replace(/\/+$/, '')}/s/${encodeURIComponent(slug)}`;
  const subject = 'Report a tour';
  // CRLF line breaks, as RFC 6068 asks of a mailto body (%0D%0A once encoded).
  const body = `Tour: ${url}\r\n\r\nWhat is wrong with it:\r\n`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};
