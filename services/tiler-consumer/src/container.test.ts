import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifestKey, tileVersionPrefix } from '@internal/contracts';

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

// Mocking @internal/tiler pins its own copy of the constant, not the real
// one - deliberately 7, not 1, so a hard-coded "t1-" would fail here.
const MOCK_TILER_OUTPUT_VERSION = 7;

const buildMock = vi.fn(async () => ({}));
const uploadDirMock = vi.fn(async () => {});
const r2GetMock = vi.fn();
const r2PutMock = vi.fn(async () => {});
const r2HeadMock = vi.fn(async () => ({ ok: true, status: 200, etag: '"abc123"' }));
const r2DeleteMock = vi.fn(async () => {});
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

vi.mock('@internal/tiler', () => ({
  build: buildMock,
  TILER_OUTPUT_VERSION: MOCK_TILER_OUTPUT_VERSION,
}));

vi.mock('@internal/worker-kit/r2-s3', () => ({
  createR2S3Client: () => ({
    get: r2GetMock,
    put: r2PutMock,
    head: r2HeadMock,
    deleteObject: r2DeleteMock,
  }),
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

const okOriginalResponse = (etag = '"abc123"') => ({
  ok: true,
  headers: new Headers({ 'content-length': '10', etag }),
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
  r2HeadMock.mockReset();
  r2HeadMock.mockResolvedValue({ ok: true, status: 200, etag: '"abc123"' });
  r2DeleteMock.mockReset();
  r2DeleteMock.mockResolvedValue(undefined);
  r2PutMock.mockReset();
  r2PutMock.mockResolvedValue(undefined);
  // A custom implementation from an ordering test must not leak into later
  // tests, which assume uploadDir is a plain no-op.
  uploadDirMock.mockReset();
  uploadDirMock.mockResolvedValue(undefined);
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

const version = `t${MOCK_TILER_OUTPUT_VERSION}-abc123`;

/** installFsTree + a matching original GET, ready for the pre-swap HEAD to run. */
const setupManifestWritten = (panoId: string): void => {
  installFsTree(buildFsTree(panoId));
  r2GetMock.mockResolvedValue(okOriginalResponse());
};

describe('container.ts /tile handler', () => {
  it('uploads under the owner-free versioned tile prefix, derived from TILER_OUTPUT_VERSION and the original ETag', async () => {
    r2GetMock.mockResolvedValue(okOriginalResponse());
    const res = await postTile(JSON.stringify({ key: 'panos/abc123/p1/original' }));

    expect(res.status).toBe(200);
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({ pano: 'p1', version }));
    expect(uploadDirMock).toHaveBeenCalledWith(
      expect.anything(),
      tileVersionPrefix('p1', version),
      expect.anything(),
    );
  });

  it('uploads the same owner-free keys regardless of which owner segment the notification carried', async () => {
    r2GetMock.mockResolvedValue(okOriginalResponse());
    const res = await postTile(JSON.stringify({ key: 'panos/ae-_vTXvv70/p2/original' }));

    expect(res.status).toBe(200);
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({ pano: 'p2', version }));
    expect(uploadDirMock).toHaveBeenCalledWith(
      expect.anything(),
      tileVersionPrefix('p2', version),
      expect.anything(),
    );
  });

  it('a duplicate delivery of the same original (same ETag) derives the identical version/keys', async () => {
    r2GetMock.mockResolvedValue(okOriginalResponse());
    uploadDirMock.mockClear();

    await postTile(JSON.stringify({ key: 'panos/abc/p-dup/original' }));
    await postTile(JSON.stringify({ key: 'panos/abc/p-dup/original' }));

    expect(uploadDirMock).toHaveBeenCalledTimes(2);
    const [, prefixA] = uploadDirMock.mock.calls[0] as [unknown, string];
    const [, prefixB] = uploadDirMock.mock.calls[1] as [unknown, string];
    expect(prefixA).toBe(prefixB);
  });

  it('derives the version from a multipart GET ETag containing a hyphen', async () => {
    r2GetMock.mockResolvedValue(okOriginalResponse('"abc-3"'));
    uploadDirMock.mockClear();
    const multipartVersion = `t${MOCK_TILER_OUTPUT_VERSION}-abc-3`;

    const res = await postTile(JSON.stringify({ key: 'panos/abc/p-multipart/original' }));

    expect(res.status).toBe(200);
    expect(buildMock).toHaveBeenCalledWith(
      expect.objectContaining({ pano: 'p-multipart', version: multipartVersion }),
    );
    expect(uploadDirMock).toHaveBeenCalledWith(
      expect.anything(),
      tileVersionPrefix('p-multipart', multipartVersion),
      expect.anything(),
    );
  });

  it('500s on a crafted GET ETag containing "/" without calling build()', async () => {
    buildMock.mockClear();
    uploadDirMock.mockClear();
    r2GetMock.mockResolvedValue(okOriginalResponse('"a/b"'));

    const res = await postTile(JSON.stringify({ key: 'panos/abc/p-crafted-etag/original' }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('must match');
    expect(buildMock).not.toHaveBeenCalled();
    expect(uploadDirMock).not.toHaveBeenCalled();
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

  it('500s when the original response has no ETag, without calling build() or uploadDir()', async () => {
    buildMock.mockClear();
    uploadDirMock.mockClear();
    r2GetMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '10' }),
      arrayBuffer: async () => new ArrayBuffer(10),
    });
    const res = await postTile(JSON.stringify({ key: 'panos/abc/p-no-etag/original' }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('ETag');
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
    expect(prefix).toBe(tileVersionPrefix(panoId, version));
    // Nothing for the original, and nothing rooted under "<panoId>/" -
    // walk() must start at work/<panoId>, not at work.
    expect(Object.keys(files).sort()).toEqual(['0/px/0-0.webp', 'manifest.json']);
  });

  it('uploads the manifest only after uploadDir has written every tile', async () => {
    const panoId = 'p-manifest-order';
    const key = `panos/abc/${panoId}/original`;
    setupManifestWritten(panoId);
    r2HeadMock.mockResolvedValue({ ok: true, status: 200, etag: '"abc123"' });
    const callOrder: string[] = [];
    uploadDirMock.mockImplementation(async () => {
      callOrder.push('tiles');
    });
    r2PutMock.mockImplementation(async (key: string) => {
      if (key === manifestKey(panoId)) callOrder.push('manifest');
    });

    const res = await postTile(JSON.stringify({ key }));

    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['tiles', 'manifest']);
    // Pins that the pre-swap HEAD targets the notification key, not a
    // derived key such as manifestKey.
    expect(r2HeadMock).toHaveBeenNthCalledWith(1, key);
  });
});

describe('orphan tile cleanup when the original is deleted mid-job', () => {
  it('deletes every uploaded tile key when the pre-swap HEAD finds the original gone, and writes no manifest', async () => {
    const panoId = 'p-gone';
    setupManifestWritten(panoId);
    r2HeadMock.mockResolvedValue({ ok: false, status: 404, etag: null });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(200);
    const prefix = tileVersionPrefix(panoId, version);
    expect(r2DeleteMock).toHaveBeenCalledTimes(1);
    expect(r2DeleteMock).toHaveBeenCalledWith(`${prefix}0/px/0-0.webp`);
    expect(r2DeleteMock).not.toHaveBeenCalledWith(manifestKey(panoId));
    expect(r2PutMock).not.toHaveBeenCalled();
  });

  it('deletes nothing when the original ETag changed instead of being gone - the pano still exists', async () => {
    const panoId = 'p-etag-changed-cleanup';
    setupManifestWritten(panoId);
    r2HeadMock.mockResolvedValue({ ok: true, status: 200, etag: '"different"' });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(200);
    expect(r2DeleteMock).not.toHaveBeenCalled();
    expect(r2PutMock).not.toHaveBeenCalled();
  });

  it('500s on a transient non-404 pre-swap HEAD status, deleting nothing and writing no manifest', async () => {
    const panoId = 'p-head-503';
    setupManifestWritten(panoId);
    r2HeadMock.mockResolvedValue({ ok: false, status: 503, etag: null });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('503');
    expect(r2DeleteMock).not.toHaveBeenCalled();
  });
});

describe('post-PUT re-check after a successful manifest write', () => {
  it("deletes the manifest and this job's tile keys when the post-PUT HEAD finds the original gone", async () => {
    const panoId = 'p-post-gone';
    setupManifestWritten(panoId);
    const key = `panos/abc/${panoId}/original`;
    r2HeadMock
      .mockResolvedValueOnce({ ok: true, status: 200, etag: '"abc123"' })
      .mockResolvedValueOnce({ ok: false, status: 404, etag: null });

    const res = await postTile(JSON.stringify({ key }));

    expect(res.status).toBe(200);
    // Pins that the post-PUT HEAD targets the notification key, not a
    // derived key such as manifestKey.
    expect(r2HeadMock).toHaveBeenNthCalledWith(2, key);
    const prefix = tileVersionPrefix(panoId, version);
    expect(r2DeleteMock).toHaveBeenCalledTimes(2);
    expect(r2DeleteMock).toHaveBeenCalledWith(manifestKey(panoId));
    expect(r2DeleteMock).toHaveBeenCalledWith(`${prefix}0/px/0-0.webp`);
  });

  it('deletes nothing when the post-PUT HEAD still matches (no DELETE happened)', async () => {
    const panoId = 'p-post-ok';
    setupManifestWritten(panoId);
    r2HeadMock.mockResolvedValue({ ok: true, status: 200, etag: '"abc123"' });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(200);
    expect(r2DeleteMock).not.toHaveBeenCalled();
  });

  it('500s and deletes nothing when the post-PUT HEAD finds a different ETag - a newer original landed mid-job', async () => {
    const panoId = 'p-post-etag-changed';
    setupManifestWritten(panoId);
    r2HeadMock
      .mockResolvedValueOnce({ ok: true, status: 200, etag: '"abc123"' })
      .mockResolvedValueOnce({ ok: true, status: 200, etag: '"newer-etag"' });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('ETag');
    expect(r2DeleteMock).not.toHaveBeenCalled();
  });

  it('500s on a transient non-404 post-PUT HEAD status, deleting nothing', async () => {
    const panoId = 'p-post-503';
    setupManifestWritten(panoId);
    r2HeadMock
      .mockResolvedValueOnce({ ok: true, status: 200, etag: '"abc123"' })
      .mockResolvedValueOnce({ ok: false, status: 503, etag: null });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('503');
    expect(r2DeleteMock).not.toHaveBeenCalled();
  });

  it('keeps deleting remaining keys when one deleteObject fails mid-cleanup, then 500s', async () => {
    const panoId = 'p-post-partial-fail';
    setupManifestWritten(panoId);
    r2HeadMock
      .mockResolvedValueOnce({ ok: true, status: 200, etag: '"abc123"' })
      .mockResolvedValueOnce({ ok: false, status: 404, etag: null });
    const prefix = tileVersionPrefix(panoId, version);
    const failingKey = manifestKey(panoId);
    r2DeleteMock.mockImplementation(async (k: string) => {
      if (k === failingKey) throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(500);
    expect(r2DeleteMock).toHaveBeenCalledWith(failingKey);
    expect(r2DeleteMock).toHaveBeenCalledWith(`${prefix}0/px/0-0.webp`);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(failingKey));
    errorSpy.mockRestore();
  });

  it('500s without a post-PUT HEAD when the manifest PUT itself throws', async () => {
    const panoId = 'p-manifest-put-throws';
    setupManifestWritten(panoId);
    r2HeadMock.mockResolvedValueOnce({ ok: true, status: 200, etag: '"abc123"' });
    r2PutMock.mockImplementation(async (key: string) => {
      if (key === manifestKey(panoId)) throw new Error('put boom');
    });

    const res = await postTile(JSON.stringify({ key: `panos/abc/${panoId}/original` }));

    expect(res.status).toBe(500);
    expect(res.body).toContain('put boom');
    expect(r2HeadMock).toHaveBeenCalledTimes(1);
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
    expect(prefix).toBe(tileVersionPrefix(panoId, version));
    expect(Object.keys(files).sort()).toEqual(['0/px/0-0.webp', 'manifest.json']);
  });
});
