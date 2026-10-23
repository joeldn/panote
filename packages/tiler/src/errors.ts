/**
 * A source build() refuses because of what the file is, not because anything
 * went wrong: a format other than JPEG, PNG or WebP, a file sharp can't read as
 * an image, or one over the pixel or aspect caps. The same bytes fail the same
 * way every time, so a caller should not retry it (tiler-consumer acks the job
 * and writes the failure marker). Every other error from build() may be transient.
 *
 * In its own module, with no sharp import, so a Worker can import it through
 * `@internal/tiler/errors` the way it imports the version.
 */
export class SourceRejectedError extends Error {
  override readonly name = 'SourceRejectedError';
}
