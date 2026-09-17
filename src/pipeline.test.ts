import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mascotPath } from './config.js';
import { createAnimation, getAnimation, jobDir, listAnimations, saveAnimation } from './library.js';
import { chromaKey, ffmpeg, ffmpegVersion, measureTransparency, prepareReference } from './video.js';
import { pollAnimation } from './pipeline.js';

const run = promisify(execFile);

test('project FFmpeg runs and reference image becomes a blue-screen frame', async () => {
  assert.match(await ffmpegVersion(), /^ffmpeg version/);
  const dir = await mkdtemp(join(tmpdir(), 'mascot-reference-'));
  try {
    const out = join(dir, 'reference.png');
    await prepareReference(mascotPath, out);
    assert.ok((await stat(out)).size > 1000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('chroma-key WebM keeps foreground opaque and blue background transparent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mascot-key-'));
  try {
    const input = join(dir, 'source.mp4');
    const output = join(dir, 'transparent.webm');
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2:d=1', '-vf', 'drawbox=x=20:y=20:w=24:h=24:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    await chromaKey(input, output);
    assert.ok((await stat(output)).size > 1000);
    const { stderr: info } = await run(ffmpeg(), ['-hide_banner', '-i', output, '-f', 'null', '-']);
    assert.match(info, /alpha_mode\s*:\s*1/);
    const { stdout } = await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', output, '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    const alpha = Buffer.from(stdout);
    assert.equal(alpha.length, 64 * 64);
    assert.ok(alpha[0] < 50, `blue corner alpha was ${alpha[0]}`);
    assert.ok(alpha[32 * 64 + 32] > 200, `red center alpha was ${alpha[32 * 64 + 32]}`);
    assert.ok((await measureTransparency(output, 1)).minTransparentPercent > 25);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('animation library writes metadata and copies reference', async () => {
  const job = await createAnimation({ title: 'Test mascot', prompt: 'Test only', imagePath: mascotPath, model: 'veo-3.1-fast-generate-preview' });
  try {
    assert.equal((await getAnimation(job.id)).title, 'Test mascot');
    assert.ok((await listAnimations()).some(x => x.id === job.id));
    assert.ok((await readFile(join('library', job.id, job.sourceImage))).length > 1000);
  } finally { await rm(join('library', job.id), { recursive: true, force: true }); }
});

test('a saved processing job resumes without calling Veo again', async () => {
  const job = await createAnimation({ title: 'Resume sample', prompt: 'local test', imagePath: mascotPath, model: 'veo-3.1-fast-generate-preview' });
  const dir = jobDir(job.id);
  try {
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2:d=1', '-vf', 'drawbox=x=20:y=20:w=24:h=24:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'original.mp4')]);
    job.rawVideo = 'original.mp4'; job.status = 'processing'; await saveAnimation(job);
    const resumed = await pollAnimation(job.id);
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.transparentVideo, 'transparent.webm');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
