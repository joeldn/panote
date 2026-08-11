import {
  ALLOWED_TILE_SIZES,
  FACES,
  MAX_FACE_SIZE,
  MAX_LEVEL_CAP,
  type Manifest as CoreManifest,
  type TileFormat,
} from '@panote/core';
import { z } from 'zod';

/**
 * The tile formats the pyramid can be encoded in.
 *
 * Declared here as a value (zod needs a runtime tuple for `z.enum`) but pinned to
 * core's `TileFormat` union with `satisfies`, so adding a format to core without
 * adding it here is a compile error rather than a silent validation gap.
 */
export const TILE_FORMATS = ['jpg', 'webp'] as const satisfies readonly TileFormat[];

/**
 * Runtime validator for `manifest.json`.
 *
 * `@panote/core` owns the *type* (`Manifest`) so that the viewer never pulls zod
 * into its bundle; this schema is the *runtime* half, derived from core's
 * constants and kept in lockstep by the two assertions below. The constraints
 * here mirror `core`'s `parseManifest`, which is the authoritative validator —
 * including its numeric bounds and its two structural invariants (faceSize ===
 * tileSize * 2^maxLevel, and faces matching FACES exactly, in order), via the
 * `.refine()` clauses below. Without them this schema would accept manifests
 * `parseManifest` rejects — any server-side path that validates with this
 * schema instead of `parseManifest` would otherwise have no bounds at all.
 */
export const ManifestSchema = z
  .object({
    pano: z.string().min(1),
    faceSize: z.number().int().positive(),
    tileSize: z.number().int().positive(),
    maxLevel: z.number().int().nonnegative(),
    faces: z.array(z.enum(FACES)).readonly(),
    quality: z.number().positive().max(100),
    format: z.enum(TILE_FORMATS),
  })
  .refine((m) => (ALLOWED_TILE_SIZES as readonly number[]).includes(m.tileSize), {
    message: `tileSize must be one of ${ALLOWED_TILE_SIZES.join(', ')}`,
    path: ['tileSize'],
  })
  .refine((m) => m.faceSize <= MAX_FACE_SIZE, {
    message: `faceSize must be <= ${MAX_FACE_SIZE}`,
    path: ['faceSize'],
  })
  .refine((m) => m.maxLevel <= MAX_LEVEL_CAP, {
    message: `maxLevel must be <= ${MAX_LEVEL_CAP}`,
    path: ['maxLevel'],
  })
  .refine((m) => m.faceSize === m.tileSize * 2 ** m.maxLevel, {
    message: 'faceSize must equal tileSize * 2^maxLevel',
    path: ['faceSize'],
  })
  .refine((m) => m.faces.length === FACES.length && m.faces.every((f, i) => f === FACES[i]), {
    message: `faces must equal ${FACES.join(', ')} in order`,
    path: ['faces'],
  });

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Bidirectional compile-time compatibility assertion between the zod-inferred
 * shape and `@panote/core`'s hand-written `Manifest` interface.
 *
 * `satisfies` operates on a *value*, and there is no runtime value of either
 * shape to test, so each direction is expressed as an exported identity function
 * that is never called: the parameter type pins one side and the `satisfies`
 * clause pins the other. Exporting them (rather than using a bare `const`) is
 * what keeps `noUnusedLocals` quiet, and a bare `expr satisfies T;` statement
 * would trip `@typescript-eslint/no-unused-expressions`.
 *
 * BOTH directions are required. One alone is not a meaningful guard:
 *   - schema -> core catches the schema being LOOSENED (e.g. `format: z.string()`).
 *   - core -> schema catches the schema gaining an EXTRA required field, or core
 *     gaining a field the schema does not have.
 * Each direction is blind to the other's failure mode.
 */
export const manifestSchemaSatisfiesCore = (m: Manifest): CoreManifest => m satisfies CoreManifest;

export const coreManifestSatisfiesSchema = (m: CoreManifest): Manifest => m satisfies Manifest;
