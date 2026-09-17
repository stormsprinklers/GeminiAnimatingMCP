import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg } from './video.js';

const run = promisify(execFile);
const WIDTH = 160;
const HEIGHT = 90;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
export const LOOP_DIFFERENCE_THRESHOLD = 6;

export interface BoundaryAnalysis { score: number; frames: number; foregroundPixels: number; }

export function compareFrames(first: Buffer, last: Buffer): { score: number; foregroundPixels: number } {
  if (first.length !== last.length || first.length % 3 !== 0) throw new Error('Frame sizes differ.');
  let difference = 0;
  let foregroundPixels = 0;
  for (let i = 0; i < first.length; i += 3) {
    const blueA = first[i + 2] > 100 && first[i + 2] > Math.max(first[i], first[i + 1]) * 1.3;
    const blueB = last[i + 2] > 100 && last[i + 2] > Math.max(last[i], last[i + 1]) * 1.3;
    if (blueA && blueB) continue;
    difference += Math.abs(first[i] - last[i]) + Math.abs(first[i + 1] - last[i + 1]) + Math.abs(first[i + 2] - last[i + 2]);
    foregroundPixels++;
  }
  if (!foregroundPixels) throw new Error('Could not find a mascot foreground to compare.');
  return { score: Math.round(difference / (foregroundPixels * 3 * 255) * 10000) / 100, foregroundPixels };
}

export async function analyzeBoundary(path: string): Promise<BoundaryAnalysis> {
  const { stdout } = await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0', '-an', '-vf', `scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=rgb24`, '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  const bytes = Buffer.from(stdout);
  const frames = Math.floor(bytes.length / FRAME_BYTES);
  if (frames < 2 || bytes.length !== frames * FRAME_BYTES) throw new Error('Could not read first and last video frames.');
  const first = bytes.subarray(0, FRAME_BYTES);
  const last = bytes.subarray((frames - 1) * FRAME_BYTES);
  return { ...compareFrames(first, last), frames };
}

export function chooseBlendFrames(score: number): number {
  return Math.max(6, Math.min(12, Math.round(6 + score / 6)));
}

export async function appendLoopBlend(input: string, output: string, directory: string, blendFrames: number, _totalFrames: number): Promise<void> {
  if (blendFrames < 6 || blendFrames > 12) throw new Error('Blend must contain 6–12 frames.');
  const first = join(directory, 'loop-first.png');
  const last = join(directory, 'loop-last.png');
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', first]);
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-0.5', '-i', input, '-frames:v', '20', '-update', '1', last]);
  if ((await stat(last)).size < 100) throw new Error('Could not extract the last frame.');
  const weight = `(N+1)/(${blendFrames + 1})`;
  const filter = `[1:v]trim=end_frame=${blendFrames},setpts=PTS-STARTPTS,format=rgb24[a];` +
    `[2:v]trim=end_frame=${blendFrames},setpts=PTS-STARTPTS,format=rgb24[b];` +
    `[a][b]blend=all_expr='A*(1-${weight})+B*${weight}',format=yuv420p[bridge];` +
    `[0:v]fps=24,format=yuv420p,setpts=PTS-STARTPTS[main];[main][bridge]concat=n=2:v=1:a=0[out]`;
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-loop', '1', '-framerate', '24', '-i', last, '-loop', '1', '-framerate', '24', '-i', first,
    '-filter_complex', filter, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', output], { maxBuffer: 4 * 1024 * 1024 });
  if ((await stat(output)).size < 1000) throw new Error('Corrected loop video is empty.');
}
