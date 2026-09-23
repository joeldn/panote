import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Exercises container.ts's actual `/tile` handler, not just the
 * deriveUploadTarget() helper it delegates to, so a regression in how
 * container.ts wires that helper in is caught even if upload-prefix.ts's
 * own tests stay green.
 *
 * container.ts listens at import time, so this mocks node:http and its
 * other side-effecting deps before importing, captures the handler
 * `createServer` was called with, and drives it with fake req/res objects.
 */

const buildMock = vi.fn(async () => ({}));
const uploadDirMock = vi.fn(async () => {});
const r2GetMock = vi.fn();
const r2PutMock = vi.fn(async () => {});
const mkdtempMock = vi.fn(async () => '/tmp/pano-test');
const readdirMock = vi.fn(async () => [] as never[]);
const readFileMock = vi.fn(async () => new Uint8Array());
const rmMock = vi.fn(async () => {});
const writeFileMock = vi.fn(async () => {});

let capturedHandler: ((req: FakeReq, res: FakeRes) => void) | undefined;

vi.mock('node:http', () => ({
  createServer: (handler: (req: FakeReq, res: FakeRes) => void) => {
    capturedHandler = handler;
    return { listen: vi.fn() };
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mkdtempMock,
  readdir: readdirMock,
  readFile: readFileMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

vi.mock('@internal/tiler', () => ({ build: buildMock }));

vi.mock('@internal/worker-kit/r2-s3', () => ({
  createR2S3Client: () => ({ get: r2GetMock, put: r2PutMock }),
}));

vi.mock('./r2io.js', () => ({ uploadDir: uploadDirMock }));

class FakeReq {
  readonly method = 'POST';
  readonly url = '/tile';
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {};
  on(event: string, cb: (...args: never[]) => void): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }
  destroy(): void {}
  emit(event: string, ...args: never[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
}

class FakeRes {
  status = 0;
  body = '';
  private resolveDone!: () => void;
  readonly done: Promise<void> = new Promise((resolve) => {
    this.resolveDone = resolve;
  });
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  end(body?: string): this {
    if (body !== undefined) this.body = body;
    this.resolveDone();
    return this;
  }
}

const okOriginalResponse = () => ({
  ok: true,
  headers: new Headers({ 'content-length': '10' }),
  arrayBuffer: async () => new ArrayBuffer(10),
});

const postTile = async (bodyStr: string): Promise<FakeRes> => {
  if (!capturedHandler) throw new Error('container.ts did not call createServer');
  const req = new FakeReq();
  const res = new FakeRes();
  capturedHandler(req, res);
  req.emit('data', bodyStr as never);
  req.emit('end');
  await res.done;
  return res;
};

beforeAll(async () => {
  process.env.R2_ACCOUNT_ID = 'test-account';
  process.env.R2_BUCKET = 'test-bucket';
  process.env.R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  await import('./container.js');
});

afterEach(() => {
  // A custom fs tree from installFsTree() must not leak into later tests.
  readdirMock.mockReset();
  readdirMock.mockResolvedValue([]);
});

interface FakeDirent {
  name: string;
  isDirectory: () => boolean;
}

const dirent = (name: string, isDirectory: boolean): FakeDirent => ({
  name,
  isDirectory: () => isDirectory,
});

// mkdtempMock's return value.
const WORK = '/tmp/pano-test';

/**
 * Installs a fake fs tree keyed by directory path, so readdir() returns real
 * entries for whatever directory walk() actually visits instead of `[]`.
 */
const installFsTree = (tree: Record<string, FakeDirent[]>): void => {
  readdirMock.mockImplementation(async (dir: unknown) => tree[dir as string] ?? []);
};

/**
 * A realistic build() output tree for a given panoId: the original at
 * WORK/.original, plus WORK/<panoId>/manifest.json and one tile.
 */
const buildFsTree = (panoId: string): Record<string, FakeDirent[]> => ({
  [WORK]: [dirent('.original', false), dirent(panoId, true)],
  [`${WORK}/${panoId}`]: [dirent('manifest.json', false), dirent('0', true)],
  [`${WORK}/${panoId}/0`]: [dirent('px', true)],
  [`${WORK}/${panoId}/0/px`]: [dirent('0-0.webp', false)],
});

describe('container.ts /tile handler', () => {
  it('uploads under the exact owner segment from the notification key, with no re-encoding', async () => {
    r2GetMock.mockResolvedValue(okOriginalResponse());
    const res = await postTile(JSON.stringify({ key: 'panos/abc123/p1/original' }));

    expect(res.status).toBe(200);
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({ pano: 'p1' }));
    // "abc123" is charset-valid but not something encodeId would produce;
    // it must still pass through unchanged.
    expect(uploadDirMock).toHaveBeenCalledWith(
      expect.anything(),
      'panos/abc123/p1/',
      expect.anything(),
    );
  });

  it('uploads under an encodeId-produced owner segment unchanged', async () => {
    r2GetMock.mockResolvedValue(okOriginalResponse());
    const res = await postTile(JSON.stringify({ key: 'panos/ae-_vTXvv70/p2/original' }));

    expect(res.status).toBe(200);
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({ pano: 'p2' }));
    expect(uploadDirMock).toHaveBeenCalledWith(
      expect.anything(),
      'panos/ae-_vTXvv70/p2/',
      expect.anything(),
    );
  });

  it('500s on a malformed notification key without calling build() or uploadDir()', async () => {
    buildMock.mockClear();
    uploadDirMock.mockClear();
    const res = await postTile(JSON.stringify({ key: 'panos/owner/p1/config.json' }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('must match');
    expect(buildMock).not.toHaveBeenCalled();
    expect(uploadDirMock).not.toHaveBeenCalled();
  });

  it('walks only work/<panoId>, uploading exactly its manifest and tile - nothing from the original and nothing under a <panoId>/ prefix', async () => {
    uploadDirMock.mockClear();
    const panoId = 'p3';
    installFsTree(buildFsTree(panoId));
    r2GetMock.mockResolvedValue(okOriginalResponse());

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(200);
    expect(uploadDirMock).toHaveBeenCalledTimes(1);
    const [files, prefix] = uploadDirMock.mock.calls[0] as [Record<string, Uint8Array>, string];
    expect(prefix).toBe(`panos/abc/${panoId}/`);
    // Nothing for the original, and nothing rooted under "<panoId>/" -
    // walk() must start at work/<panoId>, not at work.
    expect(Object.keys(files).sort()).toEqual(['0/px/0-0.webp', 'manifest.json']);
  });
});

describe('original file placement', () => {
  it('writes the original outside the build output tree, so a panoId of "src" cannot collide with it', async () => {
    writeFileMock.mockClear();
    uploadDirMock.mockClear();
    const panoId = 'src';
    installFsTree(buildFsTree(panoId));
    r2GetMock.mockResolvedValue(okOriginalResponse());

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(200);
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({ pano: 'src', outDir: WORK }));
    const [writtenPath] = writeFileMock.mock.calls.at(-1) as [string, Uint8Array];
    // Must not be work/src - that would collide with build()'s own
    // work/<panoId> output directory.
    expect(writtenPath).not.toBe(`${WORK}/src`);
    expect(writtenPath).toBe(`${WORK}/.original`);

    const [files, prefix] = uploadDirMock.mock.calls[0] as [Record<string, Uint8Array>, string];
    expect(prefix).toBe(`panos/abc/${panoId}/`);
    expect(Object.keys(files).sort()).toEqual(['0/px/0-0.webp', 'manifest.json']);
  });
});
