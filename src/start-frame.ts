import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { geminiKey, libraryRoot } from './config.js';
import { ffmpeg } from './video.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const START_FRAME_MODEL = 'gemini-3.1-flash-image';
export interface PreparedFrame { id: string; prompt: string; model: string; sourceImage: string; startFrameImage: string; blueBackgroundPercent: number; createdAt: string; }

function preparedDir(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid prepared frame ID.');
  return join(libraryRoot, '_prepared', id);
}

export async function getPreparedFrame(id: string): Promise<{ frame: PreparedFrame; sourcePath: string; startFramePath: string }> {
  const dir = preparedDir(id);
  const frame = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as PreparedFrame;
  if (frame.id !== id || !/^source\.(png|jpg|jpeg|webp)$/.test(frame.sourceImage) || frame.startFrameImage !== 'start-frame.png') throw new Error('Prepared frame metadata is invalid.');
  return { frame, sourcePath: join(dir, frame.sourceImage), startFramePath: join(dir, frame.startFrameImage) };
}

export function buildStartFrameRequest(prompt: string, imageBytes: string, mimeType: string): GenerateContentParameters {
  return {
    model: START_FRAME_MODEL,
    contents: [{ inlineData: { data: imageBytes, mimeType } }, { text: `Use the provided mascot image as the character reference. Create a NEW opening frame for a 2D mascot animation. ${prompt.trim()} Preserve the recognizable character design, illustration style, and any clothing or features that the request does not explicitly change. Show the complete character and all requested props, fully inside the frame. Make a single clean 16:9 composition with a locked camera and a perfectly uniform solid chroma-blue #0000FF background. No scenery, floor, cast shadow, gradient, text, extra characters, or blue parts on the character. The output must show the requested starting pose before the motion begins.` }],
    config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } }
  };
}

export async function measureBlueBackground(path: string): Promise<number> {
  const { stdout } = await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', 'scale=64:36:flags=neighbor', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  const pixels = Buffer.from(stdout);
  if (pixels.length !== 64 * 36 * 3) throw new Error('Could not inspect the prepared starting image.');
  let blue = 0;
  for (let i = 0; i < pixels.length; i += 3) if (pixels[i] < 16 && pixels[i + 1] < 16 && pixels[i + 2] > 239) blue++;
  return Math.round(blue / (64 * 36) * 10000) / 100;
}

export async function prepareStartFrame(input: { imagePath: string; prompt: string }, generate?: (request: GenerateContentParameters) => Promise<GenerateContentResponse>): Promise<PreparedFrame> {
  const prompt = input.prompt.trim();
  if (prompt.length < 8 || prompt.length > 1800) throw new Error('Describe the new starting pose or design in 8–1800 characters.');
  const ext = extname(input.imagePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('Use a PNG, JPG, or WebP mascot reference.');
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
  const source = await readFile(input.imagePath);
  if (source.length < 100 || source.length > 10 * 1024 * 1024) throw new Error('Mascot image must be between 100 bytes and 10 MB.');
  const request = buildStartFrameRequest(prompt, source.toString('base64'), mimeType);
  const response = await (generate || (value => new GoogleGenAI({ apiKey: geminiKey() }).models.generateContent(value)))(request);
  const part = response.candidates?.flatMap(candidate => candidate.content?.parts || []).filter(value => !value.thought && value.inlineData?.data && /^image\/(png|jpeg|webp)$/.test(value.inlineData.mimeType || '')).at(-1);
  if (!part?.inlineData?.data) throw new Error('Gemini did not return a starting image. Try a shorter pose description.');
  const image = Buffer.from(part.inlineData.data, 'base64');
  if (image.length < 100 || image.length > 15 * 1024 * 1024) throw new Error('Gemini returned an invalid starting image.');
  const id = randomUUID();
  const dir = preparedDir(id);
  await mkdir(dir, { recursive: true });
  const sourceImage = `source${ext}`;
  const generatedExt = part.inlineData.mimeType === 'image/jpeg' ? 'jpg' : part.inlineData.mimeType?.split('/')[1];
  const generatedPath = join(dir, `generated.${generatedExt}`);
  await copyFile(input.imagePath, join(dir, sourceImage));
  await writeFile(generatedPath, image);
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0000FF:s=1280x720:d=1', '-i', generatedPath,
    '-filter_complex', '[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0000FF,format=rgba,chromakey=0x0000FF:0.2:0.04[fg];[0:v][fg]overlay=shortest=1:format=auto,format=rgb24',
    '-frames:v', '1', join(dir, 'start-frame.png')], { maxBuffer: 4 * 1024 * 1024 });
  const blueBackgroundPercent = await measureBlueBackground(join(dir, 'start-frame.png'));
  if (blueBackgroundPercent < 10) throw new Error('Prepared image did not keep enough solid chroma-blue background. Try describing a full-body character on a plain blue background.');
  const frame: PreparedFrame = { id, prompt, model: START_FRAME_MODEL, sourceImage, startFrameImage: 'start-frame.png', blueBackgroundPercent, createdAt: new Date().toISOString() };
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(frame, null, 2), { mode: 0o600 });
  return frame;
}
