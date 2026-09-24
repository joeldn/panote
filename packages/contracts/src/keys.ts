import { PANO_PATTERN } from '@panote/core';

// panoId/tourId are used verbatim, only checked against PANO_PATTERN,
// because the viewer builds tile/manifest URLs from the manifest's raw
// pano value - encoding them here would desync the tiler's key from
// that URL.
const assertValidId = (id: string, label: string): string => {
  if (!PANO_PATTERN.test(id)) {
    throw new Error(`${label} must match ${PANO_PATTERN} (got ${JSON.stringify(id)})`);
  }
  return id;
};

// The S3 path is percent-decoded while binding keys are literal, which
// is why the owner segment is base64url: encodeURIComponent output
// (e.g. "%7C") would resolve to two different physical keys depending
// on which access path wrote or read it.

// TextEncoder + btoa are standard in both workerd and Node; Buffer isn't
// guaranteed in workerd.
const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const textEncoder = new TextEncoder();

/**
 * Encodes the owner segment as base64url of its UTF-8 bytes, restricted
 * to URL-unreserved characters. See assertValidId above for why
 * panoId/tourId aren't encoded this way.
 */
export const encodeId = (raw: string): string => bytesToBase64Url(textEncoder.encode(raw));

export const panoPrefix = (u: string, p: string): string =>
  `panos/${encodeId(u)}/${assertValidId(p, 'panoId')}/`;
export const originalKey = (u: string, p: string): string => `${panoPrefix(u, p)}original`;
export const configKey = (u: string, p: string): string => `${panoPrefix(u, p)}config.json`;
export const userPanosPrefix = (u: string): string => `panos/${encodeId(u)}/`;
export const tourKey = (u: string, t: string): string =>
  `tours/${encodeId(u)}/${assertValidId(t, 'tourId')}/tour.json`;

// Owner-free: base64url(sub) is reversible, so these must stay safe for a
// public bucket - panoId alone (a server-generated UUID) is unique enough.
export const TILES_ROOT = 'tiles/';
export const tilesPrefix = (p: string): string => `${TILES_ROOT}${assertValidId(p, 'panoId')}/`;
export const tileVersionPrefix = (p: string, v: string): string =>
  `${tilesPrefix(p)}${assertValidId(v, 'version')}/`;
export const manifestKey = (p: string): string => `${tilesPrefix(p)}manifest.json`;

export { PANO_PATTERN };
