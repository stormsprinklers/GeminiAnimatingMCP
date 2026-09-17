import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { mascotPath } from './config.js';
import { getAnimation, jobDir, listAnimations, saveAnimation } from './library.js';
import { pollAnimation, reprocessLoop, startAnimation } from './pipeline.js';
import { chromaKey, ffmpeg, inspectVideo, measureTransparency } from './video.js';
import { analyzeBoundary, LOOP_DIFFERENCE_THRESHOLD } from './loop-video.js';
import { LOOP_PRESETS } from './loops.js';
import { getPreparedFrame, prepareEndingFrame, prepareStartFrame } from './start-frame.js';

const run = promisify(execFile);
const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

function makeServer(): McpServer {
  const server = new McpServer({ name: 'chestnut-cheer-animations', version: '1.3.0' }, { instructions: 'For a new mascot pose, call prepare_start_frame and inspect_prepared_frame. For a non-loop animation with a controlled ending, call prepare_ending_frame from that starting frame and inspect it; then pass both frame IDs to generate_animation with loop=false. Loops must use the same frame at both ends. Check status until ready, preview, review, revise, reprocess, and catalog. Image preparation and Veo generation may use paid API credits.' });

  server.registerTool('prepare_start_frame', {
    title: 'Prepare a new mascot starting frame', description: 'Edit the supplied mascot reference into a new pose, position, prop, or design before video generation. Saves an image for review; this image-generation call may incur charges.',
    inputSchema: z.object({ prompt: z.string().min(8).max(1800), imagePath: z.string().optional() })
  }, async ({ prompt, imagePath }) => { const frame = await prepareStartFrame({ imagePath: imagePath || mascotPath, prompt }); return textResult({ ...frame, previewUrl: `http://127.0.0.1:4177/api/prepared-frames/${frame.id}/image` }); });

  server.registerTool('prepare_ending_frame', {
    title: 'Prepare a controlled ending frame', description: 'Generate an ending pose from an approved starting frame and the planned motion. Review it before Veo generation; this image-generation call may incur charges.',
    inputSchema: z.object({ startFrameId: z.string().uuid(), prompt: z.string().min(8).max(1800), action: z.string().min(4).max(1800) })
  }, async ({ startFrameId, prompt, action }) => { const frame = await prepareEndingFrame({ startFrameId, prompt, motionPrompt: action }); return textResult({ ...frame, previewUrl: `http://127.0.0.1:4177/api/prepared-frames/${frame.id}/image` }); });

  server.registerTool('inspect_prepared_frame', {
    title: 'Inspect prepared starting frame', description: 'Show the prompt-edited starting image before spending Veo credits.', inputSchema: z.object({ id: z.string().uuid() }), annotations: { readOnlyHint: true }
  }, async ({ id }) => { const prepared = await getPreparedFrame(id); const data = (await readFile(prepared.startFramePath)).toString('base64'); return { content: [{ type: 'text' as const, text: `${prepared.frame.prompt}\nPrepared frame ${id}` }, { type: 'image' as const, mimeType: 'image/png', data }] }; });

  server.registerTool('generate_animation', {
    title: 'Generate mascot animation', description: 'Submit the Chestnut & Cheer squirrel reference image and motion description to Gemini Veo. Returns a saved animation ID; generation may incur charges.',
    inputSchema: z.object({ title: z.string().min(2).max(100), action: z.string().min(4).max(1800), loop: z.boolean().default(false), preset: z.string().optional(), durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(), model: z.string().optional(), preparedFrameId: z.string().uuid().optional(), endingFrameId: z.string().uuid().optional(), imagePath: z.string().optional() })
  }, async ({ title, action, loop, preset, durationSeconds, model, preparedFrameId, endingFrameId, imagePath }) => textResult(await startAnimation({ title, action, imagePath: imagePath || mascotPath, preparedFrameId, endingFrameId, loop, preset, durationSeconds, model })));

  server.registerTool('list_loop_presets', {
    title: 'List loop presets', description: 'Show the ten loop-friendly mascot motion presets and suggested clip lengths.', inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => textResult(LOOP_PRESETS));

  server.registerTool('generate_loop_animation', {
    title: 'Generate looping animation', description: 'Use matching first and last blue-composited frames derived from the transparent mascot image with Veo 3.1. Defaults to Lite at 720p and 4 seconds; unsupported durations may be retried at 8 seconds. This uses paid API credits.',
    inputSchema: z.object({ title: z.string().min(2).max(100), action: z.string().min(4).max(1800).optional(), preset: z.string().optional(), durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(), model: z.string().optional(), preparedFrameId: z.string().uuid().optional(), imagePath: z.string().optional() })
  }, async ({ title, action, preset, durationSeconds, model, preparedFrameId, imagePath }) => textResult(await startAnimation({ title, action: action || '', imagePath: imagePath || mascotPath, preparedFrameId, loop: true, preset, durationSeconds, model })));

  server.registerTool('create_loop_variations', {
    title: 'Create loop variations', description: 'Submit 2–4 variations of one loop motion. Each variation is a separate paid Veo job.',
    inputSchema: z.object({ title: z.string().min(2).max(80), action: z.string().min(4).max(1800), count: z.number().int().min(2).max(4), durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).default(4), model: z.string().optional(), preparedFrameId: z.string().uuid().optional() })
  }, async ({ title, action, count, durationSeconds, model, preparedFrameId }) => {
    const results = [];
    for (let i = 1; i <= count; i++) {
      try { const job = await startAnimation({ title: `${title} ${i}`, action, imagePath: mascotPath, preparedFrameId, loop: true, durationSeconds, model }); results.push({ variation: i, id: job.id, status: job.status }); }
      catch (error) { results.push({ variation: i, error: String(error instanceof Error ? error.message : error) }); break; }
    }
    return textResult(results);
  });

  server.registerTool('check_animation', {
    title: 'Check animation job', description: 'Poll a Veo job. On completion, downloads the original MP4 and exports transparent WebM.',
    inputSchema: z.object({ id: z.string().uuid() }), annotations: { readOnlyHint: false }
  }, async ({ id }) => textResult(await pollAnimation(id)));

  server.registerTool('list_animations', {
    title: 'List animation library', description: 'List saved mascot animations, their status, review, and tags.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => textResult(await listAnimations()));

  server.registerTool('list_approved_loops', {
    title: 'List approved loops', description: 'List only looping animations that are ready and explicitly approved.', inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => textResult((await listAnimations()).filter(job => job.loopEnabled && job.status === 'ready' && job.approvalStatus === 'approved')));

  server.registerTool('preview_loop', {
    title: 'Preview continuous loop', description: 'Return the local page that plays an exported WebM continuously for boundary inspection.',
    inputSchema: z.object({ id: z.string().uuid() }), annotations: { readOnlyHint: true }
  }, async ({ id }) => { const job = await getAnimation(id); if (!job.loopEnabled || !job.transparentVideo) throw new Error('Loop export is not ready.'); return textResult({ id, previewUrl: `http://127.0.0.1:4177/preview/${id}`, file: join(jobDir(id), job.transparentVideo), firstLastDifferenceScore: job.firstLastDifferenceScore, finalBoundaryDifferenceScore: job.finalBoundaryDifferenceScore }); });

  server.registerTool('preview_animation', {
    title: 'Preview animation', description: 'Open the local player for either a one-time animation or a continuous loop.', inputSchema: z.object({ id: z.string().uuid() }), annotations: { readOnlyHint: true }
  }, async ({ id }) => { const job = await getAnimation(id); if (job.status !== 'ready' || !job.rawVideo) throw new Error('Animation is not ready.'); return textResult({ id, previewUrl: `http://127.0.0.1:4177/preview/${id}`, loop: !!job.loopEnabled, transparentFile: job.transparentVideo ? join(jobDir(id), job.transparentVideo) : undefined }); });

  server.registerTool('evaluate_loop_quality', {
    title: 'Evaluate loop boundary', description: 'Measure first/last frame differences before and after correction and verify alpha/audio in the WebM.',
    inputSchema: z.object({ id: z.string().uuid() })
  }, async ({ id }) => {
    const job = await getAnimation(id);
    if (!job.loopEnabled || !job.rawVideo || !job.transparentVideo) throw new Error('Loop export is not ready.');
    const raw = await analyzeBoundary(join(jobDir(id), job.rawVideo));
    const final = await analyzeBoundary(job.outputPaths?.corrected || join(jobDir(id), job.rawVideo));
    const output = await inspectVideo(join(jobDir(id), job.transparentVideo));
    const alpha = await measureTransparency(join(jobDir(id), job.transparentVideo), output.duration);
    job.firstLastDifferenceScore = raw.score; job.finalBoundaryDifferenceScore = final.score; job.minTransparentBackgroundPercent = alpha.minTransparentPercent; await saveAnimation(job);
    return textResult({ id, rawDifferencePercent: raw.score, finalDifferencePercent: final.score, correctionApplied: job.correctiveBlendApplied, blendFrames: job.blendFrames, thresholdPercent: LOOP_DIFFERENCE_THRESHOLD, alphaTrack: output.alphaMode, minTransparentBackgroundPercent: alpha.minTransparentPercent, audioRemoved: !output.hasAudio, durationSeconds: output.duration, needsVisualReview: final.score > LOOP_DIFFERENCE_THRESHOLD || alpha.minTransparentPercent < 25 || output.hasAudio });
  });

  server.registerTool('inspect_animation_frame', {
    title: 'Inspect animation frame', description: 'Return a PNG frame from the original MP4 or transparent WebM so Codex can visually review the mascot.',
    inputSchema: z.object({ id: z.string().uuid(), second: z.number().min(0).max(30).default(4), transparent: z.boolean().default(false) }), annotations: { readOnlyHint: true }
  }, async ({ id, second, transparent }) => {
    const job = await getAnimation(id);
    const filename = transparent ? job.transparentVideo : job.rawVideo;
    if (!filename) throw new Error('Video is not ready yet.');
    const input = join(jobDir(id), filename);
    const { stdout } = await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', ...(transparent ? ['-c:v', 'libvpx-vp9'] : []), '-ss', String(second), '-i', input, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const data = Buffer.from(stdout).toString('base64');
    return { content: [{ type: 'text' as const, text: `${job.title}, ${second}s, ${transparent ? 'transparent WebM' : 'original MP4'}` }, { type: 'image' as const, mimeType: 'image/png', data }] };
  });

  server.registerTool('review_animation', {
    title: 'Record animation review', description: 'Save visual review notes on an animation for later revisions.',
    inputSchema: z.object({ id: z.string().uuid(), review: z.string().min(1).max(2000) })
  }, async ({ id, review }) => { const job = await getAnimation(id); job.review = review; await saveAnimation(job); return textResult(job); });

  server.registerTool('revise_animation', {
    title: 'Revise mascot animation', description: 'Generate a new Veo animation from the same reference image, linked to its parent. This may incur charges.',
    inputSchema: z.object({ parentId: z.string().uuid(), title: z.string().min(2).max(100), action: z.string().min(4).max(1800), loop: z.boolean().optional(), durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(), model: z.string().optional(), preparedFrameId: z.string().uuid().optional(), endingFrameId: z.string().uuid().optional() })
  }, async ({ parentId, title, action, loop, durationSeconds, model, preparedFrameId, endingFrameId }) => { const parent = await getAnimation(parentId); const startId = preparedFrameId || parent.preparedFrameId; const isLoop = loop ?? parent.loopEnabled; return textResult(await startAnimation({ title, action, imagePath: join(jobDir(parentId), parent.sourceImage), preparedFrameId: startId, endingFrameId: isLoop ? undefined : endingFrameId || (startId === parent.preparedFrameId ? parent.endingFrameId : undefined), parentId, loop: isLoop, durationSeconds: durationSeconds || parent.durationSeconds, model: model || parent.model })); });

  server.registerTool('process_animation', {
    title: 'Refine transparent export', description: 'Reprocess an existing original MP4 with adjustable blue-screen removal. Keeps previous exports in the animation folder.',
    inputSchema: z.object({ id: z.string().uuid(), similarity: z.number().min(0.01).max(0.5).default(0.17), blend: z.number().min(0).max(0.5).default(0.03) })
  }, async ({ id, similarity, blend }) => {
    const job = await getAnimation(id);
    if (job.loopEnabled) return textResult(await reprocessLoop(id, similarity, blend));
    if (!job.rawVideo) throw new Error('Original MP4 is not ready.');
    const filename = `transparent-${Date.now()}.webm`;
    await chromaKey(join(jobDir(id), job.rawVideo), join(jobDir(id), filename), similarity, blend);
    if ((await stat(join(jobDir(id), filename))).size < 1000) throw new Error('Transparent export was empty.');
    job.transparentVideo = filename;
    job.status = 'ready';
    await saveAnimation(job);
    return textResult({ ...job, videoCheck: await inspectVideo(join(jobDir(id), filename)) });
  });

  server.registerTool('reprocess_animation', {
    title: 'Reprocess loop transparency', description: 'Regenerate a transparent WebM from an existing loop MP4 without calling Veo.',
    inputSchema: z.object({ id: z.string().uuid(), similarity: z.number().min(0.01).max(0.5).default(0.17), blend: z.number().min(0).max(0.5).default(0.03) })
  }, async ({ id, similarity, blend }) => textResult(await reprocessLoop(id, similarity, blend)));

  server.registerTool('approve_loop', {
    title: 'Approve loop animation', description: 'Mark a reviewed, ready loop as approved for the catalog.',
    inputSchema: z.object({ id: z.string().uuid(), review: z.string().min(1).max(2000) })
  }, async ({ id, review }) => { const job = await getAnimation(id); if (!job.loopEnabled || job.status !== 'ready' || (job.minTransparentBackgroundPercent ?? 0) < 25) throw new Error('Only a ready loop with verified transparency can be approved.'); job.approvalStatus = 'approved'; job.review = review; await saveAnimation(job); return textResult(job); });

  server.registerTool('catalog_animation', {
    title: 'Catalog animation', description: 'Save searchable tags and notes for an animation in the local library.',
    inputSchema: z.object({ id: z.string().uuid(), tags: z.array(z.string().min(1).max(40)).max(12), notes: z.string().max(2000).default('') })
  }, async ({ id, tags, notes }) => { const job = await getAnimation(id); job.tags = tags; job.notes = notes; await saveAnimation(job); return textResult(job); });

  return server;
}

serveStdio(makeServer);
