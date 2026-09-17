import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const libraryRoot = resolve(root, 'library');
export const mascotPath = resolve(root, 'assets', 'full-body-mascot.png');

export function loadEnv(): void {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

export function geminiKey(): string {
  loadEnv();
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error('Gemini API key is missing. Open .env and add GEMINI_API_KEY=your-key.');
  return key;
}

export function veoModel(): string {
  loadEnv();
  const model = process.env.VEO_MODEL?.trim() || 'veo-3.1-fast-generate-preview';
  if (!['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview'].includes(model)) throw new Error('Unsupported VEO_MODEL in .env.');
  return model;
}
