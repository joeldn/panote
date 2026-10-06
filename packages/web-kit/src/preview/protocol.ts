import {
  decodePreviewImage,
  type DecodedPreview,
  type DecodeEnv,
  type DecodeRequest,
} from './decode.js';

export interface DecodeMessage {
  type: 'decode';
  file: Blob;
  request: DecodeRequest;
}

export type DecodeResponse =
  { type: 'done'; result: DecodedPreview | null } | { type: 'error'; message: string };

/** The worker's whole job, minus `postMessage`: the reply plus what to transfer. */
export async function runDecodeJob(
  message: DecodeMessage,
  env: DecodeEnv,
): Promise<{ response: DecodeResponse; transfer: Transferable[] }> {
  try {
    const result = await decodePreviewImage(message.file, message.request, env);
    const transfer = (result?.source.patches ?? []).map((p) => p.image as ImageBitmap);
    return { response: { type: 'done', result }, transfer };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { response: { type: 'error', message: text }, transfer: [] };
  }
}
