import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mascotPath } from './config.js';
import { LOOP_PRESETS, LOOP_REQUIREMENTS } from './loops.js';
import { analyzeBoundary, appendLoopBlend, chooseBlendFrames, compareFrames, compareVideoToKeyframes } from './loop-video.js';
import { ffmpeg, inspectVideo, prepareTransparentReference } from './video.js';
import { animationPrompt, buildVideoRequest, pollAnimation, submitVideoOperation } from './pipeline.js';
import { createAnimation, jobDir, saveAnimation } from './library.js';
import { GenerateVideosOperation } from '@google/genai';

const run = promisify(execFile);

test('all requested loop presets exist and loop requirement is explicit', () => {
  assert.equal(LOOP_PRESETS.length, 10);
  assert.match(LOOP_REQUIREMENTS, /exactly one complete cyclic motion/);
  assert.match(LOOP_REQUIREMENTS, /final frame must visually match the first frame/);
  assert.ok(LOOP_PRESETS.every(p => [4, 6, 8].includes(p.durationSeconds)));
});

test('Veo request sends identical first/last images and keeps non-loop route intact', async () => {
  const loop = await createAnimation({ title: 'Request loop', prompt: animationPrompt('Blink once.', true), imagePath: mascotPath, model: 'veo-3.1-lite-generate-preview', loopEnabled: true, durationSeconds: 4 });
  const standard = await createAnimation({ title: 'Request standard', prompt: animationPrompt('Wave once.'), imagePath: mascotPath, model: 'veo-3.1-fast-generate-preview', durationSeconds: 8 });
  try {
    const loopRequest = buildVideoRequest(loop, 'same-png-bytes');
    assert.equal(loopRequest.source?.image?.imageBytes, loopRequest.config?.lastFrame?.imageBytes);
    assert.equal(loopRequest.config?.generateAudio, false);
    assert.equal(loopRequest.config?.durationSeconds, 4);
    assert.match(loop.prompt, /exactly one complete cyclic motion/);
    const standardRequest = buildVideoRequest(standard, 'blue-screen-image');
    assert.equal(standardRequest.config?.lastFrame, undefined);
    assert.equal(standardRequest.config?.durationSeconds, 8);
  } finally { await rm(jobDir(loop.id), { recursive: true, force: true }); await rm(jobDir(standard.id), { recursive: true, force: true }); }
});

test('unsupported 4-second first/last request retries at 8 seconds without audio setting', async () => {
  const job = await createAnimation({ title: 'Retry loop', prompt: animationPrompt('Blink once.', true), imagePath: mascotPath, model: 'veo-3.1-lite-generate-preview', loopEnabled: true, durationSeconds: 4 });
  const requests: Array<{ duration: number | undefined; audio: boolean | undefined }> = [];
  try {
    const operation = await submitVideoOperation(job, 'same-png-bytes', async request => {
      requests.push({ duration: request.config?.durationSeconds, audio: request.config?.generateAudio });
      if (request.config?.durationSeconds !== 8 || request.config?.generateAudio !== undefined) throw new Error('Your use case is currently not supported.');
      const accepted = new GenerateVideosOperation(); accepted.name = 'accepted-loop-operation'; return accepted;
    });
    assert.equal(operation.name, 'accepted-loop-operation');
    assert.deepEqual(requests, [{ duration: 4, audio: false }, { duration: 4, audio: undefined }, { duration: 8, audio: false }, { duration: 8, audio: undefined }]);
    assert.equal(job.durationSeconds, 8);
    assert.equal(job.audioDisableAccepted, false);
  } finally { await rm(jobDir(job.id), { recursive: true, force: true }); }
});

test('loop reference stays transparent while matching a 16:9 frame', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-reference-'));
  try {
    const image = join(dir, 'reference.png');
    await prepareTransparentReference(mascotPath, image);
    const { stdout } = await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', image, '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
    const alpha = Buffer.from(stdout);
    assert.equal(alpha.length, 1280 * 720);
    assert.ok(alpha[0] < 10, `corner alpha ${alpha[0]}`);
    assert.ok(alpha[360 * 1280 + 640] > 200, 'mascot center must be opaque');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('frame score detects mismatches and blend is 6–12 frames', () => {
  const first = Buffer.from([255, 0, 0, 0, 0, 255]);
  const last = Buffer.from([0, 255, 0, 0, 0, 255]);
  const result = compareFrames(first, last);
  assert.ok(result.score > 50);
  assert.equal(result.foregroundPixels, 1);
  assert.equal(chooseBlendFrames(0), 6);
  assert.equal(chooseBlendFrames(100), 12);
});

test('video endpoints are compared to their separate planned pictures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-keyframes-'));
  try {
    const start = join(dir, 'start.png');
    const end = join(dir, 'end.png');
    const video = join(dir, 'video.mp4');
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90', '-vf', 'drawbox=x=20:y=30:w=30:h=30:color=red:t=fill', '-frames:v', '1', start]);
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90', '-vf', 'drawbox=x=100:y=30:w=30:h=30:color=red:t=fill', '-frames:v', '1', end]);
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-t', '0.5', '-i', start, '-loop', '1', '-t', '0.5', '-i', end, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const correct = await compareVideoToKeyframes(video, start, end);
    const reversed = await compareVideoToKeyframes(video, end, start);
    assert.ok(correct.startDifferenceScore < reversed.startDifferenceScore);
    assert.ok(correct.endDifferenceScore < reversed.endDifferenceScore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('blend appends frames, removes audio in export, and preserves WebM alpha', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-blend-'));
  try {
    const input = join(dir, 'original.mp4');
    const corrected = join(dir, 'corrected.mp4');
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=1', '-vf', 'drawbox=x=20:y=20:w=24:h=24:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    const analysis = await analyzeBoundary(input);
    assert.equal(analysis.frames, 24);
    await appendLoopBlend(input, corrected, dir, 6, analysis.frames);
    assert.ok((await stat(corrected)).size > 1000);
    const result = await analyzeBoundary(corrected);
    assert.equal(result.frames, 30);
    const video = await inspectVideo(corrected);
    assert.equal(video.hasAudio, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved loop job measures and corrects a mismatched boundary', async () => {
  const job = await createAnimation({ title: 'Correction sample', prompt: 'local', imagePath: mascotPath, model: 'veo-3.1-lite-generate-preview', loopEnabled: true, durationSeconds: 4 });
  const dir = jobDir(job.id);
  try {
    const input = join(dir, 'original.mp4');
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=0.5', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=0.5',
      '-filter_complex', '[0:v]drawbox=x=8:y=20:w=16:h=16:color=red:t=fill[a];[1:v]drawbox=x=38:y=20:w=16:h=16:color=red:t=fill[b];[a][b]concat=n=2:v=1:a=0[out]',
      '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    job.rawVideo = 'original.mp4'; job.status = 'processing'; await saveAnimation(job);
    const result = await pollAnimation(job.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.correctiveBlendApplied, true);
    assert.ok((result.blendFrames || 0) >= 6 && (result.blendFrames || 0) <= 12);
    assert.ok((result.finalBoundaryDifferenceScore || 100) < (result.firstLastDifferenceScore || 0));
    const output = await inspectVideo(join(dir, result.transparentVideo!));
    assert.equal(output.alphaMode, true);
    assert.equal(output.hasAudio, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
