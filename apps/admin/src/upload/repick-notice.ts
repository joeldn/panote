import type { Uploads } from './upload-context.js';

/** Why the file has to be chosen again, for the overlay's notice. */
export const repickNotice = ({ fileName, reason }: NonNullable<Uploads['repick']>): string =>
  reason === 'signed-out'
    ? `You were signed out before “${fileName}” finished uploading. Choose it again to continue.`
    : `Choose “${fileName}” again to upload it.`;
