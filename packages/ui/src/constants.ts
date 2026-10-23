/** Copy buttons flip to "Copied ✓" for this long (design README, Interactions). */
export const COPY_CONFIRM_MS = 1600;
/** At or below this width the layout is mobile: nav links hide, panels become sheets. */
export const MOBILE_MAX_WIDTH = 600;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
/**
 * The sandbox for every iframe we put on a page: the YouTube/Vimeo players and the
 * admin embed preview (which can hold a player, and a nested frame keeps its
 * parent's limits). Scripts and their own storage; forms (Vimeo's password and
 * email-gated players); casting; and popups ("Watch on YouTube", the embed's
 * "open in Panote" link) that open a normal tab. Never allow-top-navigation, so a
 * compromised frame can't move the page. Fullscreen isn't a sandbox flag: it comes
 * from the `allow` attribute. The preview is our own same-origin page, so for it
 * the sandbox is defence in depth, not a boundary.
 */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-presentation allow-popups allow-popups-to-escape-sandbox';
