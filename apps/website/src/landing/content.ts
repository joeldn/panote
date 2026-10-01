// Landing copy (design README, screen 1). Free, not open source: no export/download promises.

export const NAV_SECTIONS = [
  { id: 'features', label: 'Features' },
  { id: 'how', label: 'How it works' },
  { id: 'showcase', label: 'Showcase' },
  { id: 'faq', label: 'FAQ' },
] as const;

export const PILLARS = [
  {
    icon: 'fa-solid fa-magnifying-glass-plus',
    tag: 'Full resolution',
    title: 'Every pixel you captured',
    body: 'Other free hosts crush your panorama to 4K. We keep every pixel, so visitors zoom into the real detail.',
  },
  {
    icon: 'fa-solid fa-infinity',
    tag: 'No limits',
    title: 'Unlimited everything',
    body: 'Unlimited hotspots, panoramas, and tours. No tiered gates, no counting.',
  },
  {
    icon: 'fa-solid fa-ban',
    tag: 'No paywall',
    title: 'No watermark, ever',
    body: 'No “made with” badge. No upsell wall in front of basic features. Free means free.',
  },
  {
    icon: 'fa-solid fa-lock-open',
    tag: 'Yours to keep',
    title: 'Your work stays yours',
    body: 'You keep full control of every tour — edit, unpublish or delete it whenever you like.',
  },
];

export const STEPS = [
  {
    num: '01 / Upload',
    title: 'Upload your panorama',
    body: 'Drop an equirectangular photo from any 360 camera. It opens in the viewer right away.',
  },
  {
    num: '02 / Process',
    title: 'We make it zoomable',
    body: 'In the background we tile it for fast, full-resolution zoom on any device.',
  },
  {
    num: '03 / Build',
    title: 'Link scenes & hotspots',
    body: 'Connect panoramas into a tour and drop hotspots with rich content.',
  },
  {
    num: '04 / Share',
    title: 'Share or embed',
    body: 'Publish a link, post to socials, or embed it anywhere. No watermark.',
  },
];

export const FEATURES = [
  {
    icon: 'fa-solid fa-diagram-project',
    title: 'Multi-scene tours',
    body: 'Link panoramas and walk between them with on-scene arrows.',
  },
  {
    icon: 'fa-solid fa-location-dot',
    title: 'Info hotspots',
    body: 'Titles, rich Markdown content, and custom icons on any point.',
  },
  {
    icon: 'fa-solid fa-map',
    title: 'Mini-map & compass',
    body: 'Show where each scene sits, and which way is north.',
  },
  {
    icon: 'fa-solid fa-magnifying-glass-plus',
    title: 'Full-resolution zoom',
    body: 'Tiled streaming keeps detail crisp all the way in.',
  },
  {
    icon: 'fa-solid fa-code',
    title: 'One-click embed & share',
    body: 'A link or an iframe. Works anywhere.',
  },
  {
    icon: 'fa-solid fa-mobile-screen',
    title: 'Mobile ready',
    body: 'Runs on phones, tablets and desktops, with no app.',
  },
];

export const COMPARE_ROWS = [
  { label: 'Max resolution', panote: 'Full', others: '4K cap' },
  { label: 'Hotspots', panote: 'Unlimited', others: 'Limited' },
  { label: 'Tours', panote: 'Unlimited', others: 'Limited' },
  { label: 'Watermark', panote: 'None', others: 'Yes' },
  { label: 'Hosted + editor', panote: 'Yes', others: 'Yes' },
  { label: 'Price', panote: 'Free', others: 'Free → paid' },
];

export const FREE_REASONS = [
  {
    icon: 'fa-solid fa-feather',
    text: 'Panote is a small, focused tool. No sales team, no growth targets to feed.',
  },
  {
    icon: 'fa-solid fa-server',
    text: 'Our hosting runs on infrastructure with no bandwidth fees, so serving your tours costs us almost nothing.',
  },
  { icon: 'fa-solid fa-shield-halved', text: 'No ads. We don’t sell your data.' },
  {
    icon: 'fa-solid fa-building',
    text: 'If we ever charge, it’s organizations that want private hosting or support — never the people sharing tours.',
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
    a: 'Yes. Uploading, hosting, hotspots, and tours are free with no limits. We don’t ask for a card.',
  },
  {
    q: 'Are there resolution limits?',
    a: 'No. We tile your panorama at full resolution, so visitors zoom into the real detail you captured.',
  },
  {
    q: 'Will you watermark my tours?',
    a: 'Never. No badge, no overlay, no “made with Panote” on your tour.',
  },
  {
    q: 'Do I need an account?',
    a: 'Only to create and manage tours — you sign in with Google. Visitors never need one: a tour link just opens.',
  },
  {
    q: 'Do I own what I upload?',
    a: 'Yes. Your panoramas stay yours — we make no claim on them and never reuse them elsewhere.',
  },
  {
    q: 'Which cameras work?',
    a: 'Any 360 camera that outputs an equirectangular image — Ricoh Theta, Insta360, GoPro Max, and others.',
  },
];

export const CONTACT_EMAIL = 'hello@panote.io';
