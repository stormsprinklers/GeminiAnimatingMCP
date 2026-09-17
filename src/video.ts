import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string | null;

const run = promisify(execFile);
export function ffmpeg(): string {
  if (!ffmpegPath) throw new Error('Project FFmpeg is missing. Run npm install.');
  return ffmpegPath;
}

export async function ffmpegVersion(): Promise<string> {
  const { stdout } = await run(ffmpeg(), ['-version']);
  return stdout.split(/\r?\n/)[0];
}

export async function chromaKey(input: string, output: string, similarity = 0.17, blend = 0.03, loop = false): Promise<void> {
  if (similarity < 0.01 || similarity > 0.5 || blend < 0 || blend > 0.5) throw new Error('Key settings out of range.');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', `chromakey=0x0000FF:${similarity}:${blend},format=yuva420p`,
    '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '30', ...(loop ? ['-metadata', 'loop=1'] : []), output];
  await run(ffmpeg(), args, { maxBuffer: 4 * 1024 * 1024 });
}

export async function prepareTransparentReference(input: string, output: string): Promise<void> {
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=1280x720:d=1', '-i', input,
    '-filter_complex', '[0:v]format=rgba,colorchannelmixer=aa=0[bg];[1:v]scale=680:680:flags=lanczos,format=rgba[mascot];[bg][mascot]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,format=rgba',
    '-frames:v', '1', output], { maxBuffer: 4 * 1024 * 1024 });
  if ((await stat(output)).size < 1000) throw new Error('Transparent reference image is empty.');
}

export async function prepareReference(input: string, output: string): Promise<void> {
  await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0000FF:s=1280x720:d=1', '-i', input,
    '-filter_complex', '[1:v]scale=680:680:flags=lanczos[mascot];[0:v][mascot]overlay=(W-w)/2:(H-h)/2:shortest=1,format=rgb24',
    '-frames:v', '1', output], { maxBuffer: 4 * 1024 * 1024 });
  if ((await stat(output)).size < 1000) throw new Error('Prepared reference image is empty.');
}

export async function inspectVideo(path: string): Promise<{ alphaMode: boolean; duration: number; hasAudio: boolean }> {
  const { stderr } = await run(ffmpeg(), ['-hide_banner', '-i', path, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024 });
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return { alphaMode: /alpha_mode\s*:\s*1/.test(stderr), duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0, hasAudio: /Stream #0:\d+(?:\(\w+\))?: Audio/.test(stderr) };
}

export async function measureTransparency(path: string, duration: number): Promise<{ minTransparentPercent: number; samples: number[] }> {
  const times = [0, Math.max(0, duration / 2), Math.max(0, duration - 0.5)];
  const samples: number[] = [];
  for (const second of times) {
    const { stdout } = await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-ss', String(second), '-i', path,
      '-vf', 'alphaextract,scale=64:36:flags=neighbor', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    const pixels = Buffer.from(stdout);
    if (pixels.length !== 64 * 36) throw new Error('Could not inspect transparent video frame.');
    let clear = 0;
    for (const alpha of pixels) if (alpha < 50) clear++;
    samples.push(Math.round(clear / pixels.length * 10000) / 100);
  }
  return { minTransparentPercent: Math.min(...samples), samples };
}
