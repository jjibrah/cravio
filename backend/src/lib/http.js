import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
/** Responses smaller than this aren't worth compressing. */
export const GZIP_MIN_BYTES = 1024;

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * An already-serialised JSON body (for cached responses). Keeps its gzip form after the first use,
 * so a cached menu is compressed once, not on every request.
 */
export class PreparedJson {
  constructor(json, { etag } = {}) {
    this.json = json;
    this.buffer = Buffer.from(json, 'utf8');
    this.etag = etag || `W/"${createHash('sha1').update(this.buffer).digest('base64url').slice(0, 27)}"`;
    this.gzipped = null;
  }

  async gzip() {
    this.gzipped ||= gzipAsync(this.buffer, { level: 6 });
    return this.gzipped;
  }
}

const acceptsGzip = (request) => /\bgzip\b/i.test(request?.headers?.['accept-encoding'] || '');

/**
 * Writes a JSON response. With `request`, bodies over 1 KB are gzipped when the client accepts it.
 * `body` may be a plain value or a PreparedJson.
 */
export async function sendJson(response, status, body, request) {
  if (body === undefined || status === 204 || status === 304) {
    response.writeHead(status);
    response.end();
    return;
  }
  const prepared = body instanceof PreparedJson ? body : null;
  const buffer = prepared ? prepared.buffer : Buffer.from(JSON.stringify(body), 'utf8');
  if (request && buffer.length >= GZIP_MIN_BYTES && acceptsGzip(request)) {
    try {
      const compressed = prepared ? await prepared.gzip() : await gzipAsync(buffer, { level: 6 });
      response.setHeader('Content-Encoding', 'gzip');
      response.setHeader('Vary', response.getHeader('Vary') ? `${response.getHeader('Vary')}, Accept-Encoding` : 'Accept-Encoding');
      response.setHeader('Content-Length', compressed.length);
      response.writeHead(status);
      response.end(compressed);
      return;
    } catch { /* fall back to the plain body */ }
  }
  response.setHeader('Content-Length', buffer.length);
  response.writeHead(status);
  response.end(buffer);
}

/** Reads a JSON body (max 1 MB). Rejects anything else with a 400. */
export async function readJson(request, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}
