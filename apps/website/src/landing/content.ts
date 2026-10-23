// Landing copy (design README, screen 1). Free, not open source: no export/download promises.
// Limits are real (copy-rule.test bans "unlimited"/"no limits"): state the numbers.
import {
  MAX_HOTSPOTS,
  MAX_TOUR_LANGUAGES,
  MAX_TOUR_MEMBERS,
  MAX_TOUR_SCENES,
  MAX_TOURS_PER_OWNER,
} from '@internal/contracts';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_PIXELS } from '@internal/web-kit';

// Per-account quotas. panoramas, storageGb and uploadsPerDay mirror upload-api's
// MAX_PANOS_PER_OWNER, MAX_BYTES_PER_OWNER and MAX_UPLOADS_PER_OWNER_PER_DAY vars (services/upload-api/wrangler.jsonc, docs/deploy.md "Owner quotas"),
// which are server config the site can't import, so keep them in step by hand.
export const ACCOUNT_LIMITS = {
  panoramas: 500,
  storageGb: 20,
  tours: MAX_TOURS_PER_OWNER,
  uploadsPerDay: 50,
} as const;

const MEGAPIXELS = MAX_UPLOAD_PIXELS / 1e6;
const MAX_FILE_MB = MAX_UPLOAD_BYTES / 1024 ** 2;

export const NAV_SECTIONS = [
  { id: 'features', label: 'Features' },
  { id: 'how', label: 'How it works' },
  { id: 'showcase', label: 'Use cases' },
  { id: 'faq', label: 'FAQ' },
] as const;

export const PILLARS = [
  {
    icon: 'fa-solid fa-magnifying-glass-plus',
    tag: 'Full resolution',
    title: 'Every pixel you captured',
    body: `Full 360° panoramas up to ${MEGAPIXELS} megapixels keep their full resolution, so visitors zoom into the real detail.`,
  },
  {
    icon: 'fa-solid fa-layer-group',
    tag: 'Limits up front',
    title: 'Room for every project',
    body: `${ACCOUNT_LIMITS.panoramas} panoramas, ${ACCOUNT_LIMITS.tours} tours and ${ACCOUNT_LIMITS.storageGb} GB per account, with ${MAX_HOTSPOTS} hotspots in every scene. One plan, no tiers to climb.`,
  },
  {
    icon: 'fa-solid fa-ban',
    tag: 'No watermark',
    title: 'Nothing on your tour but your tour',
    body: 'No “made with” badge, no overlay, no upgrade prompt in front of the basics.',
  },
  {
    icon: 'fa-solid fa-lock-open',
    tag: 'You’re in control',
    title: 'Your work stays yours',
    body: 'Tours start unlisted. Make one public, stop sharing it or delete it whenever you like.',
  },
];

export const STEPS = [
  {
    num: '01 / Upload',
    title: 'Upload a 360° photo',
    body: 'Drop a JPG, PNG or WebP from any 360 camera. It opens in the viewer right away.',
  },
  {
    num: '02 / Process',
    title: 'We make it zoomable',
    body: 'While you build, we prepare it in the background for sharp, full-resolution zoom on any device.',
  },
  {
    num: '03 / Build',
    title: 'Link scenes & hotspots',
    body: 'Connect panoramas into a tour, then add hotspots with text, images, audio or video.',
  },
  {
    num: '04 / Share',
    title: 'Share or embed',
    body: 'Publish a link, post it to socials, or embed the tour on your own site.',
  },
];

export const FEATURES = [
  {
    icon: 'fa-solid fa-diagram-project',
    title: 'Multi-scene tours',
    body: `Link up to ${MAX_TOUR_SCENES} panoramas and walk between them with on-scene arrows.`,
  },
  {
    icon: 'fa-solid fa-location-dot',
    title: 'Info hotspots',
    body: 'Titles, formatted text, images, audio and video, with a choice of icons.',
  },
  {
    icon: 'fa-solid fa-map',
    title: 'Mini-map & compass',
    body: 'Place scenes on your floor plan and show which way is north.',
  },
  {
    icon: 'fa-solid fa-magnifying-glass-plus',
    title: 'Full-resolution zoom',
    body: 'Only the detail you’re looking at loads, so zoom stays sharp and fast.',
  },
  {
    icon: 'fa-solid fa-code',
    title: 'Share & embed',
    body: 'A link, a social post or an iframe on your own site.',
  },
  {
    icon: 'fa-solid fa-mobile-screen',
    title: 'Mobile ready',
    body: 'Runs in the browser on phones, tablets and desktops. Tilt your phone to look around.',
  },
  {
    icon: 'fa-solid fa-user-group',
    title: 'Edit together',
    body: 'Invite editors to a tour, or hand the tour over to one of them.',
  },
  {
    icon: 'fa-solid fa-globe',
    title: 'Many languages',
    body: `Offer a tour in up to ${MAX_TOUR_LANGUAGES} languages. Visitors pick theirs.`,
  },
  {
    icon: 'fa-solid fa-chart-line',
    title: 'Insights',
    body: 'See views, time spent and which hotspots people open.',
  },
];

// The other column is hedged on purpose: it describes free tiers in general, not a named rival.
export const COMPARE_ROWS = [
  { label: 'Resolution', panote: `Up to ${MEGAPIXELS} MP, in full`, others: 'Often downscaled' },
  { label: 'Hotspots', panote: `${MAX_HOTSPOTS} per scene`, others: 'Often capped' },
  { label: 'Tours', panote: `${ACCOUNT_LIMITS.tours} per account`, others: 'Often capped' },
  { label: 'Branding on your tour', panote: 'None', others: 'Often a badge' },
  { label: 'Price', panote: 'Free', others: 'Free, then paid' },
];

export const FREE_REASONS = [
  {
    icon: 'fa-solid fa-feather',
    text: 'Panote is a small, focused tool. No sales team, no growth targets to feed.',
  },
  {
    icon: 'fa-solid fa-server',
    text: 'Tours are served from storage with no bandwidth fees, so even a busy tour costs us very little.',
  },
  { icon: 'fa-solid fa-shield-halved', text: 'No ads. We don’t sell your data.' },
  {
    icon: 'fa-solid fa-building',
    text: 'We have no plans to charge people for sharing tours.',
  },
];

export const USE_CASES = [
  {
    icon: 'fa-solid fa-landmark',
    title: 'Museums & heritage',
    tint: 'linear-gradient(160deg,#3a2f24,#7a5a38 70%,#c8a05a)',
  },
  {
    icon: 'fa-solid fa-house',
    title: 'Real estate',
    tint: 'linear-gradient(160deg,#26323a,#46708a 70%,#9fc4d6)',
  },
  {
    icon: 'fa-solid fa-graduation-cap',
    title: 'Education',
    tint: 'linear-gradient(160deg,#2c241f,#6a4636 70%,#b58a5a)',
  },
  {
    icon: 'fa-solid fa-plane',
    title: 'Travel & hospitality',
    tint: 'linear-gradient(160deg,#1f3a33,#357a5e 70%,#86c7a6)',
  },
  {
    icon: 'fa-solid fa-calendar-day',
    title: 'Events',
    tint: 'linear-gradient(160deg,#33233a,#6a3f7a 70%,#b58ac6)',
  },
];

export const FAQS = [
  {
    q: 'Is it really free?',
    a: `Yes. Uploading, hosting, hotspots and tours are all free, and we never ask for a card. The limits are real and stated up front: ${ACCOUNT_LIMITS.panoramas} panoramas, ${ACCOUNT_LIMITS.tours} tours and ${ACCOUNT_LIMITS.storageGb} GB per account, ${ACCOUNT_LIMITS.uploadsPerDay} uploads a day, ${MAX_TOUR_SCENES} scenes per tour, ${MAX_HOTSPOTS} hotspots per scene, and files up to ${MAX_FILE_MB} MB.`,
  },
  {
    q: 'Who can see my tours?',
    a: 'Tours are unlisted by default: anyone with the link can open one, but it isn’t listed anywhere. Make a tour public to show it on Explore. Stop sharing, and the link and every embed go offline.',
  },
  {
    q: 'What happens if Panote shuts down?',
    a: 'We have no plans to, and our terms say we’ll give notice where we reasonably can. Panote is a host, not a backup, so keep your original photos, as you would with any host.',
  },
  {
    q: 'Are there resolution limits?',
    a: `Full 360° panoramas up to ${MEGAPIXELS} megapixels are kept at their full resolution, so visitors zoom into the real detail you captured. A partial panorama is padded out to a full sphere first, and only scaled down if that takes it past the limit.`,
  },
  {
    q: 'Will you watermark my tours?',
    a: 'Never. No badge, no overlay, no “made with Panote” on your tour.',
  },
  {
    q: 'Do I need an account?',
    a: 'Only to create and manage tours. You sign in with an account you already have, so there’s no new password to remember. Visitors never need one: a tour link just opens.',
  },
  {
    q: 'Can other people work on a tour with me?',
    a: `Yes. Invite up to ${MAX_TOUR_MEMBERS} editors to a tour and they can change it with you. You stay the owner, and you can hand the tour over to one of them.`,
  },
  {
    q: 'Do I own what I upload?',
    a: 'Yes. Your panoramas stay yours. We only use them to show your tours to the people you share them with, and on Explore if you make a tour public.',
  },
  {
    q: 'Which cameras work?',
    a: `Any 360 camera whose app saves a stitched, equirectangular photo: Ricoh Theta, Insta360, GoPro Max and others. Upload JPG, PNG or WebP, up to ${MAX_FILE_MB} MB and ${MEGAPIXELS} megapixels.`,
  },
];

// Shared with web-kit's error copy, so the address lives in one place.
export { CONTACT_EMAIL } from '@internal/web-kit';
