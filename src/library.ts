import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { libraryRoot } from './config.js';

export type JobStatus = 'created' | 'generating' | 'processing' | 'ready' | 'failed';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export interface Animation {
  id: string;
  title: string;
  prompt: string;
  model: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sourceImage: string;
  operationName?: string;
  rawVideo?: string;
  transparentVideo?: string;
  error?: string;
  parentId?: string;
  review?: string;
  tags?: string[];
  notes?: string;
  loopEnabled?: boolean;
  loopPreset?: string;
  durationSeconds?: 4 | 6 | 8;
  requestedDurationSeconds?: 4 | 6 | 8;
  outputDurationSeconds?: number;
  firstLastDifferenceScore?: number;
  finalBoundaryDifferenceScore?: number;
  correctiveBlendApplied?: boolean;
  blendFrames?: number;
  approvalStatus?: ApprovalStatus;
  outputPaths?: { original?: string; transparent?: string; preview?: string; corrected?: string; startFrame?: string; endingFrame?: string };
  estimatedGenerationCostUsd?: number;
  audioDisableRequested?: boolean;
  audioDisableAccepted?: boolean;
  lastFrameAccepted?: boolean;
  minTransparentBackgroundPercent?: number;
  loopReferenceMode?: string;
  preparedFrameId?: string;
  startFramePrompt?: string;
  startFrameModel?: string;
  startFrameImage?: string;
  endingFrameId?: string;
  endingFramePrompt?: string;
  endingFrameModel?: string;
  endingFrameImage?: string;
  startFrameMatchScore?: number;
  endFrameMatchScore?: number;
}

export function jobDir(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid animation ID.');
  return join(libraryRoot, id);
}

export async function createAnimation(input: { title: string; prompt: string; imagePath: string; model: string; parentId?: string; loopEnabled?: boolean; loopPreset?: string; durationSeconds?: 4 | 6 | 8 }): Promise<Animation> {
  const id = randomUUID();
  const dir = jobDir(id);
  await mkdir(dir, { recursive: true });
  const ext = extname(input.imagePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('Use a PNG, JPG, or WebP reference image.');
  const sourceImage = `source${ext}`;
  await copyFile(input.imagePath, join(dir, sourceImage));
  const now = new Date().toISOString();
  const job: Animation = { id, title: input.title.trim(), prompt: input.prompt.trim(), model: input.model, status: 'created', createdAt: now, updatedAt: now, sourceImage, parentId: input.parentId, loopEnabled: input.loopEnabled || false, loopPreset: input.loopPreset, durationSeconds: input.durationSeconds, approvalStatus: 'pending', outputPaths: {} };
  await saveAnimation(job);
  return job;
}

export async function saveAnimation(job: Animation): Promise<void> {
  job.updatedAt = new Date().toISOString();
  const dir = jobDir(job.id);
  const tmp = join(dir, `metadata-${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, join(dir, 'metadata.json')); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt === 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  } finally { await rm(tmp, { force: true }); }
}

export async function getAnimation(id: string): Promise<Animation> {
  return JSON.parse(await readFile(join(jobDir(id), 'metadata.json'), 'utf8')) as Animation;
}

export async function listAnimations(): Promise<Animation[]> {
  await mkdir(libraryRoot, { recursive: true });
  const entries = await readdir(libraryRoot, { withFileTypes: true });
  const jobs = await Promise.all(entries.filter(x => x.isDirectory() && /^[0-9a-f-]{36}$/.test(x.name)).map(async x => {
    try { return await getAnimation(x.name); } catch { return undefined; }
  }));
  return jobs.filter((x): x is Animation => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function displayFilename(job: Animation): string { return basename(job.title).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || job.id; }
