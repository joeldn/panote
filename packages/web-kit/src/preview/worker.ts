import { browserDecodeEnv } from './decode.js';
import { runDecodeJob, type DecodeMessage } from './protocol.js';

// Thin shell: everything it calls is tested in Node. Started by `decodePreview`.
interface WorkerScope {
  onmessage: ((event: MessageEvent<DecodeMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  void runDecodeJob(event.data, browserDecodeEnv()).then(({ response, transfer }) => {
    scope.postMessage(response, transfer);
  });
};
