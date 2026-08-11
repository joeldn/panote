#!/usr/bin/env node
/* eslint-disable no-console -- this file IS a CLI; stdout is its interface */
import { build } from './build.js';
import type { TileFormat } from '@panote/core';

function intArg(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`--${name} must be a positive integer (got ${raw})`);
  return n;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const src = args[0];
  if (!src || src.startsWith('--')) {
    throw new Error(
      'usage: pano-tile <src> --out <dir> --pano <name> [--tile 512] [--max-size N] [--quality 70]',
    );
  }
  const opts: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (!key?.startsWith('--') || val === undefined) {
      throw new Error(`bad argument near ${key}`);
    }
    opts[key.slice(2)] = val;
  }
  return { src, opts };
}

async function main() {
  const { src, opts } = parseArgs(process.argv);
  if (!opts.out || !opts.pano) throw new Error('--out and --pano are required');

  const tileSize = intArg(opts.tile, 'tile');
  const maxSize = intArg(opts['max-size'], 'max-size');

  const qualityRaw = opts.quality ? Number(opts.quality) : undefined;
  if (
    qualityRaw !== undefined &&
    (!Number.isFinite(qualityRaw) || qualityRaw < 1 || qualityRaw > 100)
  ) {
    throw new Error(`--quality must be a number between 1 and 100 (got ${opts.quality})`);
  }

  const formatRaw = opts.format ?? 'webp';
  if (formatRaw !== 'jpg' && formatRaw !== 'webp') {
    throw new Error(`--format must be 'jpg' or 'webp' (got ${formatRaw})`);
  }
  const format: TileFormat = formatRaw;

  await build({
    src,
    outDir: opts.out,
    pano: opts.pano,
    tileSize,
    maxSize,
    quality: qualityRaw,
    format,
    onProgress: (m) => console.log(m),
  });
  console.log('done');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
