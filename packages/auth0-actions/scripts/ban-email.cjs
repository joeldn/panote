// @ts-check
'use strict';

/*
 * Prints the hash to add to the ban list (the stack's `bannedEmailSha256` secret, which
 * infra/pulumi deploys as the "Block banned emails" Action's BANNED_EMAIL_SHA256) for an email
 * address (docs/deploy.md, "Email ban list"). Nothing is sent anywhere.
 *
 *   node packages/auth0-actions/scripts/ban-email.cjs someone@example.com [another@example.com]
 */

const main = async () => {
  /** @type {typeof import('../src/ban-list.cjs')} */
  const { emailHash, normaliseEmail } = await import('../src/ban-list.cjs');
  const emails = process.argv.slice(2);
  if (emails.length === 0 || emails.some((e) => !e.includes('@'))) {
    console.error('usage: node packages/auth0-actions/scripts/ban-email.cjs <email> [<email> ...]');
    process.exitCode = 1;
    return;
  }
  for (const email of emails) {
    // The hash alone on stdout, ready to append; what was hashed goes to stderr.
    console.error(`hashed as ${normaliseEmail(email)}`);
    // eslint-disable-next-line no-console -- stdout is this CLI's output
    console.log(await emailHash(email));
  }
};

void main();
