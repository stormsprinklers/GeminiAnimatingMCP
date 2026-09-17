import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { geminiKey, libraryRoot, mascotPath, root } from './config.js';
import { getAnimation, jobDir, listAnimations, saveAnimation } from './library.js';
import { pollAnimation, startAnimation } from './pipeline.js';
import { LOOP_PRESETS } from './loops.js';
import { getPreparedFrame, prepareStartFrame } from './start-frame.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4177);
const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webm: 'video/webm', mp4: 'video/mp4' };

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    total += part.length;
    if (total > 15 * 1024 * 1024) throw new Error('Image upload is too large (15 MB maximum).');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function imagePath(body: Record<string, unknown>): Promise<{ path: string; temporary: boolean }> {
  if (typeof body.imageData !== 'string' || !body.imageData) return { path: mascotPath, temporary: false };
  const match = body.imageData.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Upload a PNG, JPG, or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 10 * 1024 * 1024 || bytes.length < 100) throw new Error('Image must be between 100 bytes and 10 MB.');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const dir = join(libraryRoot, '_uploads');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${ext}`);
  await writeFile(path, bytes);
  return { path, temporary: true };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const segments = url.pathname.split('/').filter(Boolean);
  if (req.headers.host !== `${host}:${port}`) { send(res, 403, { error: 'This app is only available on its local address.' }); return; }
  if (req.method === 'POST') {
    if (req.headers.origin && req.headers.origin !== `http://${host}:${port}`) { send(res, 403, { error: 'Request origin is not allowed.' }); return; }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { send(res, 415, { error: 'Send JSON requests only.' }); return; }
  }
  if (req.method === 'GET' && url.pathname === '/') {
    const html = await readFile(join(root, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'", 'X-Content-Type-Options': 'nosniff' });
    res.end(html); return;
  }
  if (req.method === 'GET' && segments[0] === 'preview' && segments.length === 2) {
    jobDir(segments[1]);
    const html = await readFile(join(root, 'public', 'preview.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'", 'X-Content-Type-Options': 'nosniff' });
    res.end(html); return;
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(join(root, 'public', 'app.js'))); return;
  }
  if (req.method === 'GET' && url.pathname === '/preview.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(join(root, 'public', 'preview.js'))); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/setup') {
    let keyReady = false;
    try { geminiKey(); keyReady = true; } catch { /* setup screen stays available */ }
    send(res, 200, { keyReady }); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/mascot') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(mascotPath)); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/prepared-frames') {
    const body = await jsonBody(req);
    const image = await imagePath(body);
    try { send(res, 201, await prepareStartFrame({ imagePath: image.path, prompt: String(body.prompt || '') })); }
    finally { if (image.temporary) await rm(image.path, { force: true }); }
    return;
  }
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'prepared-frames' && segments[2] && segments.length === 4 && segments[3] === 'image') {
    const prepared = await getPreparedFrame(segments[2]);
    const data = await readFile(prepared.startFramePath);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data); return;
  }
  if (req.method === 'GET' && url.pathname === '/api/animations') { send(res, 200, await listAnimations()); return; }
  if (req.method === 'GET' && url.pathname === '/api/loop-presets') { send(res, 200, LOOP_PRESETS); return; }
  if (req.method === 'POST' && url.pathname === '/api/animations') {
    const body = await jsonBody(req);
    const image = body.preparedFrameId ? { path: mascotPath, temporary: false } : await imagePath(body);
    try {
      const job = await startAnimation({ title: String(body.title || ''), action: String(body.action || ''), imagePath: image.path,
        loop: body.loop === true, preset: typeof body.preset === 'string' ? body.preset : undefined,
        durationSeconds: Number(body.durationSeconds || 4) as 4 | 6 | 8,
        model: typeof body.model === 'string' ? body.model : undefined,
        preparedFrameId: typeof body.preparedFrameId === 'string' ? body.preparedFrameId : undefined });
      send(res, 201, job);
    } finally { if (image.temporary) await rm(image.path, { force: true }); }
    return;
  }
  if (segments[0] === 'api' && segments[1] === 'animations' && segments[2]) {
    const id = segments[2];
    if (req.method === 'GET' && segments.length === 3) { send(res, 200, await pollAnimation(id)); return; }
    if (req.method === 'GET' && segments[3] === 'file' && segments[4] && segments.length === 5) {
      const job = await getAnimation(id);
      const filename = ({ source: job.sourceImage, start: job.startFrameImage, reference: job.loopEnabled ? 'loop-reference.png' : 'keyed-reference.png', original: job.rawVideo, corrected: job.correctiveBlendApplied ? 'loop-corrected.mp4' : job.rawVideo, transparent: job.transparentVideo } as Record<string, string | undefined>)[segments[4]];
      if (!filename) { send(res, 404, { error: 'File is not ready.' }); return; }
      const data = await readFile(join(jobDir(id), filename));
      const extension = filename.split('.').pop() || 'png';
      res.writeHead(200, { 'Content-Type': mime[extension] || 'application/octet-stream', 'Content-Length': data.length, 'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff' });
      res.end(data); return;
    }
    if (req.method === 'POST' && segments[3] === 'review' && segments.length === 4) {
      const body = await jsonBody(req);
      const job = await getAnimation(id);
      job.review = String(body.review || '').slice(0, 2000);
      await saveAnimation(job);
      send(res, 200, job); return;
    }
    if (req.method === 'POST' && segments[3] === 'revise' && segments.length === 4) {
      const body = await jsonBody(req);
      const parent = await getAnimation(id);
      const job = await startAnimation({ title: String(body.title || `${parent.title} revision`), action: String(body.action || ''), imagePath: join(jobDir(id), parent.sourceImage), parentId: id,
        loop: typeof body.loop === 'boolean' ? body.loop : parent.loopEnabled, preset: typeof body.preset === 'string' ? body.preset : undefined,
        durationSeconds: Number(body.durationSeconds || parent.durationSeconds || 4) as 4 | 6 | 8,
        model: typeof body.model === 'string' ? body.model : parent.model,
        preparedFrameId: typeof body.preparedFrameId === 'string' ? body.preparedFrameId : parent.preparedFrameId });
      send(res, 201, job); return;
    }
  }
  send(res, 404, { error: 'Not found.' });
}

createServer((req, res) => {
  route(req, res).catch(error => {
    const message = String(error instanceof Error ? error.message : error).replace(/AIza[\w-]+/g, '[redacted key]');
    if (!res.headersSent) send(res, /not found|ENOENT|Invalid animation ID/i.test(message) ? 404 : 400, { error: message });
    else res.end();
  });
}).listen(port, host, () => console.log(`Chestnut & Cheer studio: http://${host}:${port}`));
