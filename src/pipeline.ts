import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GoogleGenAI, GenerateVideosOperation, type GenerateVideosParameters } from '@google/genai';
import { geminiKey, veoModel } from './config.js';
import { createAnimation, getAnimation, jobDir, saveAnimation, type Animation } from './library.js';
import { chromaKey, inspectVideo, measureTransparency, prepareReference } from './video.js';
import { LOOP_REQUIREMENTS, loopPreset } from './loops.js';
import { analyzeBoundary, appendLoopBlend, chooseBlendFrames, LOOP_DIFFERENCE_THRESHOLD } from './loop-video.js';
import { getPreparedFrame } from './start-frame.js';

const active = new Set<string>();
const POLL_MS = 10_000;

function client(): GoogleGenAI { return new GoogleGenAI({ apiKey: geminiKey() }); }

export function animationPrompt(action: string, loop = false): string {
  if (loop) return `${action.trim()} ${LOOP_REQUIREMENTS} Keep the background a perfectly solid uniform chroma blue #0000FF on every generated frame, with no shadows, gradients, scenery, text, or camera movement.`;
  return `Animate the exact character from the supplied starting image. Begin in that image's pose, position, clothing, and design. Preserve the recognizable character design and illustration style except for changes explicitly requested. ${action.trim()} Keep the complete character and any requested props visible, with a fixed camera. Smooth expressive 2D character animation. Keep the backdrop perfectly flat uniform saturated chroma blue (#0000FF) throughout every frame, with no gradient, texture, shadows, blue objects, extra characters, text, logos, or scene changes.`;
}

const models = ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview'];
export interface StartAnimationInput { title: string; action: string; imagePath: string; preparedFrameId?: string; parentId?: string; loop?: boolean; preset?: string; durationSeconds?: 4 | 6 | 8; model?: string; }

export function buildVideoRequest(job: Animation, imageBytes: string, includeAudioSetting = true): GenerateVideosParameters {
  const image = { imageBytes, mimeType: 'image/png' };
  return {
    model: job.model,
    source: { prompt: job.prompt, image },
    config: {
      numberOfVideos: 1, durationSeconds: job.durationSeconds || 8, aspectRatio: '16:9', resolution: '720p',
      ...(job.loopEnabled ? { lastFrame: image, ...(includeAudioSetting ? { generateAudio: false } : {}) } : {})
    }
  };
}

function unsupportedUseCase(error: unknown): boolean {
  return /Your use case is currently not supported|lastFrame|last frame|interpolat|generateAudio|audio.*(?:unsupported|not supported|must be true)/i.test(safeError(error));
}

export async function submitVideoOperation(job: Animation, imageBytes: string, generate: (request: GenerateVideosParameters) => Promise<GenerateVideosOperation>): Promise<GenerateVideosOperation> {
  if (!job.loopEnabled) return generate(buildVideoRequest(job, imageBytes));
  const requested = job.durationSeconds || 4;
  const durations: (4 | 6 | 8)[] = requested === 8 ? [8] : [requested, 8];
  let lastError: unknown;
  for (const duration of durations) {
    job.durationSeconds = duration;
    for (const includeAudioSetting of [true, false]) {
      job.audioDisableRequested = true;
      try {
        const operation = await generate(buildVideoRequest(job, imageBytes, includeAudioSetting));
        job.audioDisableAccepted = includeAudioSetting;
        return operation;
      } catch (error) {
        lastError = error;
        if (!unsupportedUseCase(error)) throw error;
      }
    }
  }
  throw new Error(`Selected model ${job.model} rejected first/last-frame looping at ${requested} and 8 seconds: ${safeError(lastError)}`);
}

export async function startAnimation(input: StartAnimationInput, videoGenerator?: (request: GenerateVideosParameters) => Promise<GenerateVideosOperation>): Promise<Animation> {
  if (input.title.trim().length < 2 || input.title.length > 100) throw new Error('Title must be 2–100 characters.');
  const preset = input.loop ? loopPreset(input.preset) : undefined;
  if (input.loop && input.preset && !preset) throw new Error('Unknown loop preset.');
  const action = input.action?.trim() || preset?.action || '';
  if (action.length < 4 || action.length > 1800) throw new Error('Describe the motion in 4–1800 characters.');
  const durationSeconds = input.loop ? (input.durationSeconds || preset?.durationSeconds || 4) : 8;
  if (![4, 6, 8].includes(durationSeconds)) throw new Error('Loop duration must be 4, 6, or 8 seconds.');
  const model = input.model || (input.loop ? 'veo-3.1-lite-generate-preview' : veoModel());
  if (!models.includes(model)) throw new Error('Selected model is not a supported Veo 3.1 model for first/last-frame generation.');
  if (!videoGenerator) geminiKey();
  const prepared = input.preparedFrameId ? await getPreparedFrame(input.preparedFrameId) : undefined;
  const job = await createAnimation({ title: input.title, prompt: animationPrompt(action, !!input.loop), imagePath: prepared?.sourcePath || input.imagePath, model, parentId: input.parentId, loopEnabled: input.loop, loopPreset: preset?.id, durationSeconds });
  job.requestedDurationSeconds = durationSeconds;
  if (prepared) { job.preparedFrameId = prepared.frame.id; job.startFramePrompt = prepared.frame.prompt; job.startFrameModel = prepared.frame.model; job.startFrameImage = 'start-frame.png'; }
  try {
    const dir = jobDir(job.id);
    const reference = input.loop ? 'loop-reference.png' : 'keyed-reference.png';
    if (prepared) await copyFile(prepared.startFramePath, join(dir, reference));
    else await prepareReference(join(dir, job.sourceImage), join(dir, reference));
    if (prepared) { await copyFile(prepared.startFramePath, join(dir, job.startFrameImage!)); job.outputPaths = { ...job.outputPaths, startFrame: join(dir, job.startFrameImage!) }; }
    if (input.loop) job.loopReferenceMode = prepared ? 'same prompt-prepared blue starting frame at both endpoints' : 'same blue-composited frame from transparent source at both endpoints';
    const imageBytes = (await readFile(join(dir, reference))).toString('base64');
    const operation = await submitVideoOperation(job, imageBytes, videoGenerator || (request => client().models.generateVideos(request)));
    if (!operation.name) throw new Error('Veo did not provide a job ID.');
    job.operationName = operation.name;
    if (input.loop) job.lastFrameAccepted = true;
    job.status = 'generating';
    await saveAnimation(job);
    if (operation.done) await finishOperation(job, operation);
    return job;
  } catch (error) {
    job.status = 'failed';
    const message = safeError(error);
    job.error = input.loop && /lastFrame|last frame|interpolat/i.test(message) && /unsupported|not supported|invalid|not allowed/i.test(message)
      ? `Selected model ${model} rejected first/last-frame control: ${message}` : message;
    await saveAnimation(job);
    throw new Error(`${job.error} (animation ${job.id})`);
  }
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/AIza[\w-]+/g, '[redacted key]').slice(0, 1000);
}

async function finishOperation(job: Animation, operation: GenerateVideosOperation): Promise<void> {
  if (operation.error) throw new Error(`Veo failed: ${JSON.stringify(operation.error)}`);
  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error(`Veo returned no video. ${operation.response?.raiMediaFilteredReasons?.join('; ') || ''}`);
  const dir = jobDir(job.id);
  const raw = join(dir, 'original.mp4');
  await client().files.download({ file: video, downloadPath: raw });
  if ((await stat(raw)).size < 1000) throw new Error('Downloaded video is empty.');
  job.rawVideo = 'original.mp4';
  job.outputPaths = { ...job.outputPaths, original: raw };
  job.status = 'processing';
  await saveAnimation(job);
  await processDownloaded(job);
}

async function processDownloaded(job: Animation): Promise<void> {
  if (!job.rawVideo) throw new Error('No downloaded MP4 to process.');
  const dir = jobDir(job.id);
  const raw = join(dir, job.rawVideo);
  let source = raw;
  if (job.loopEnabled) {
    const boundary = await analyzeBoundary(raw);
    job.firstLastDifferenceScore = boundary.score;
    job.correctiveBlendApplied = boundary.score > LOOP_DIFFERENCE_THRESHOLD;
    job.blendFrames = job.correctiveBlendApplied ? chooseBlendFrames(boundary.score) : 0;
    if (job.correctiveBlendApplied) {
      source = join(dir, 'loop-corrected.mp4');
      await appendLoopBlend(raw, source, dir, job.blendFrames, boundary.frames);
      job.outputPaths = { ...job.outputPaths, corrected: source };
    }
    job.finalBoundaryDifferenceScore = (await analyzeBoundary(source)).score;
  }
  const transparent = join(dir, 'transparent.webm');
  await chromaKey(source, transparent, 0.17, 0.03, !!job.loopEnabled);
  if ((await stat(transparent)).size < 1000) throw new Error('Transparent WebM is empty.');
  const inspection = await inspectVideo(transparent);
  if (!inspection.alphaMode || inspection.hasAudio) throw new Error('Loop export did not preserve transparency or remove audio.');
  const alpha = await measureTransparency(transparent, inspection.duration);
  job.minTransparentBackgroundPercent = alpha.minTransparentPercent;
  if (alpha.minTransparentPercent < (job.loopEnabled ? 25 : 10)) throw new Error(`Background removal left an opaque backdrop (${alpha.minTransparentPercent}% transparent). The Veo output may not have held a solid blue background.`);
  job.transparentVideo = 'transparent.webm';
  job.outputDurationSeconds = inspection.duration;
  job.outputPaths = { ...job.outputPaths, transparent, preview: `http://127.0.0.1:4177/preview/${job.id}` };
  if (job.model === 'veo-3.1-lite-generate-preview') job.estimatedGenerationCostUsd = Math.round((job.durationSeconds || 8) * 0.05 * 100) / 100;
  job.status = 'ready';
  delete job.error;
  await saveAnimation(job);
}

export async function reprocessLoop(id: string, similarity = 0.17, blend = 0.03): Promise<Animation> {
  const job = await getAnimation(id);
  if (!job.loopEnabled || !job.rawVideo) throw new Error('This animation has no downloaded loop source.');
  const dir = jobDir(id);
  const source = job.correctiveBlendApplied && job.outputPaths?.corrected ? job.outputPaths.corrected : join(dir, job.rawVideo);
  const output = join(dir, `transparent-${Date.now()}.webm`);
  await chromaKey(source, output, similarity, blend, true);
  const inspected = await inspectVideo(output);
  if (!inspected.alphaMode || inspected.hasAudio) throw new Error('Reprocessed WebM failed transparency or audio checks.');
  const alpha = await measureTransparency(output, inspected.duration);
  if (alpha.minTransparentPercent < 25) throw new Error(`Background removal left an opaque backdrop (${alpha.minTransparentPercent}% transparent).`);
  job.transparentVideo = output.split(/[\\/]/).pop();
  job.outputDurationSeconds = inspected.duration;
  job.minTransparentBackgroundPercent = alpha.minTransparentPercent;
  job.outputPaths = { ...job.outputPaths, transparent: output };
  job.approvalStatus = 'pending';
  await saveAnimation(job);
  return job;
}

export async function pollAnimation(id: string): Promise<Animation> {
  const job = await getAnimation(id);
  if (!['generating', 'processing'].includes(job.status) || active.has(id)) return job;
  active.add(id);
  try {
    if (job.status === 'processing') await processDownloaded(job);
    else if (job.operationName) {
      const savedOperation = new GenerateVideosOperation();
      savedOperation.name = job.operationName;
      const operation = await client().operations.getVideosOperation({ operation: savedOperation });
      if (operation.done) await finishOperation(job, operation);
    }
  } catch (error) {
    job.error = safeError(error);
    if (/^Veo (failed:|returned no video)|^Background removal left/.test(job.error)) job.status = 'failed';
    await saveAnimation(job);
  } finally { active.delete(id); }
  return job;
}

export async function awaitAnimation(id: string, timeoutMs = 20 * 60_000): Promise<Animation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await pollAnimation(id);
    if (job.status === 'ready' || job.status === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  return getAnimation(id);
}
