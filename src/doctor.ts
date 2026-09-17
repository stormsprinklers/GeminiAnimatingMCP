import { existsSync } from 'node:fs';
import { geminiKey, loadEnv, mascotPath, veoModel } from './config.js';
import { ffmpegVersion } from './video.js';

async function main(): Promise<void> {
  console.log(`Node.js: ${process.version}`);
  console.log(`FFmpeg: ${await ffmpegVersion()}`);
  console.log(`Mascot image: ${existsSync(mascotPath) ? 'ready' : 'missing'}`);
  loadEnv();
  try { geminiKey(); console.log('Gemini API key: present (value hidden)'); }
  catch { console.log('Gemini API key: missing'); }
  console.log(`Veo model: ${veoModel()}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
