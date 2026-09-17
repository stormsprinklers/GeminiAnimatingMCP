import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root, mascotPath } from './config.js';
import { createAnimation, jobDir, saveAnimation } from './library.js';
import { ffmpeg } from './video.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pollAnimation } from './pipeline.js';

const run = promisify(execFile);

test('MCP stdio server exposes generation, review, revision, processing, and catalog tools', async () => {
  const client = new Client({ name: 'animation-studio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'], cwd: root });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map(tool => tool.name));
    for (const name of ['prepare_start_frame', 'prepare_ending_frame', 'inspect_prepared_frame', 'generate_animation', 'generate_loop_animation', 'create_loop_variations', 'check_animation', 'list_animations', 'list_loop_presets', 'list_approved_loops', 'preview_loop', 'preview_animation', 'evaluate_loop_quality', 'inspect_animation_frame', 'review_animation', 'revise_animation', 'process_animation', 'reprocess_animation', 'approve_loop', 'catalog_animation']) assert.ok(names.has(name), `${name} missing`);
    const result = await client.callTool({ name: 'list_animations', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]?.type, 'text');
    assert.ok(Array.isArray(JSON.parse(result.content[0].text)));
  } finally { await client.close(); }
});

test('MCP previews, evaluates, reprocesses, and approves a saved loop', async () => {
  const job = await createAnimation({ title: 'MCP loop sample', prompt: 'local test', imagePath: mascotPath, model: 'veo-3.1-lite-generate-preview', loopEnabled: true, durationSeconds: 4 });
  const dir = jobDir(job.id);
  const client = new Client({ name: 'animation-studio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'], cwd: root });
  try {
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=1', '-vf', 'drawbox=x=20:y=20:w=24:h=24:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'original.mp4')]);
    job.rawVideo = 'original.mp4'; job.status = 'processing'; await saveAnimation(job);
    assert.equal((await pollAnimation(job.id)).status, 'ready');
    await client.connect(transport);
    const preview = await client.callTool({ name: 'preview_loop', arguments: { id: job.id } });
    assert.match(JSON.stringify(preview.content), /\/preview\//);
    const evaluated = await client.callTool({ name: 'evaluate_loop_quality', arguments: { id: job.id } });
    assert.match(JSON.stringify(evaluated.content), /audioRemoved/);
    const processed = await client.callTool({ name: 'reprocess_animation', arguments: { id: job.id } });
    assert.match(JSON.stringify(processed.content), /transparent-\d+\.webm/);
    const approved = await client.callTool({ name: 'approve_loop', arguments: { id: job.id, review: 'Local loop check passed.' } });
    assert.match(JSON.stringify(approved.content), /approved/);
    const listed = await client.callTool({ name: 'list_approved_loops', arguments: {} });
    assert.match(JSON.stringify(listed.content), new RegExp(job.id));
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MCP tools process, inspect, review, and catalog a local sample', async () => {
  const job = await createAnimation({ title: 'MCP sample', prompt: 'local test', imagePath: mascotPath, model: 'veo-3.1-fast-generate-preview' });
  const dir = jobDir(job.id);
  const client = new Client({ name: 'animation-studio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'], cwd: root });
  try {
    await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2:d=1', '-vf', 'drawbox=x=20:y=20:w=24:h=24:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'original.mp4')]);
    job.rawVideo = 'original.mp4'; job.status = 'processing'; await saveAnimation(job);
    await client.connect(transport);
    const processed = await client.callTool({ name: 'process_animation', arguments: { id: job.id } });
    assert.equal(processed.isError, undefined);
    assert.match(JSON.stringify(processed.content), /transparent-\d+\.webm/);
    const frame = await client.callTool({ name: 'inspect_animation_frame', arguments: { id: job.id, second: 0 } });
    assert.equal(frame.content[1]?.type, 'image');
    const review = await client.callTool({ name: 'review_animation', arguments: { id: job.id, review: 'Foreground stays visible.' } });
    assert.match(JSON.stringify(review.content), /Foreground stays visible/);
    const catalog = await client.callTool({ name: 'catalog_animation', arguments: { id: job.id, tags: ['test', 'mascot'], notes: 'Local test only.' } });
    assert.match(JSON.stringify(catalog.content), /mascot/);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
