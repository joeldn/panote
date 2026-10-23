import { CONTACT_EMAIL } from '@internal/web-kit';

/**
 * A mailto to ask for help, with the account ID filled in. Panote keeps no
 * emails, so the ID is how the operator finds the account a message is about.
 */
export const supportHref = (accountId: string | undefined): string => {
  const subject = 'Help with my Panote account';
  // CRLF line breaks, as RFC 6068 asks of a mailto body (%0D%0A once encoded).
  const body = `${accountId ? `Account ID: ${accountId}\r\n\r\n` : ''}What happened:\r\n`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};
