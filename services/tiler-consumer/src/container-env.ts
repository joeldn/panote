export interface ContainerEnv {
  readonly R2_ACCOUNT_ID: string;
  readonly R2_BUCKET: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly MAX_ORIGINAL_BYTES?: string | undefined;
}

const REQUIRED = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

/**
 * Values the container process reads from process.env. wrangler's [[containers]]
 * block carries build-time image_vars only, so anything the container needs at
 * RUNTIME has to be forwarded explicitly through Container.envVars - otherwise the
 * container builds its S3 client from undefined and every tile job 500s into the
 * DLQ without a visible error.
 */
export const containerEnvVars = (env: ContainerEnv): Record<string, string> => {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`tiler container env missing: ${missing.join(', ')}`);
  }
  return {
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET: env.R2_BUCKET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    ...(env.MAX_ORIGINAL_BYTES ? { MAX_ORIGINAL_BYTES: env.MAX_ORIGINAL_BYTES } : {}),
  };
};
