import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateContentParameters, GenerateContentResponse, GenerateVideosOperation, GenerateVideosParameters } from '@google/genai';
import { libraryRoot, mascotPath } from './config.js';
import { jobDir } from './library.js';
import { startAnimation } from './pipeline.js';
import { buildStartFrameRequest, getPreparedFrame, prepareStartFrame, START_FRAME_MODEL } from './start-frame.js';
import { prepareReference } from './video.js';

test('a prompt-prepared frame can anchor both loop and non-loop videos', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'prepared-mascot-'));
  let preparedId = '';
  const jobIds: string[] = [];
  try {
    const mockImage = join(temp, 'edited.png');
    await prepareReference(mascotPath, mockImage);
    const imageBytes = (await readFile(mockImage)).toString('base64');
    const editRequests: GenerateContentParameters[] = [];
    const frame = await prepareStartFrame({ imagePath: mascotPath, prompt: 'Seat the chipmunk with a wrapped present in both hands.' }, async request => {
      editRequests.push(request);
      return { candidates: [{ content: { parts: [{ inlineData: { data: imageBytes, mimeType: 'image/png' } }] } }] } as GenerateContentResponse;
    });
    preparedId = frame.id;
    assert.equal(editRequests[0]?.model, START_FRAME_MODEL);
    assert.match(JSON.stringify(editRequests[0]?.contents), /wrapped present/);
    assert.deepEqual(editRequests[0]?.config?.responseModalities, ['IMAGE']);
    assert.equal(editRequests[0]?.config?.imageConfig?.aspectRatio, '16:9');
    assert.ok((await stat((await getPreparedFrame(frame.id)).startFramePath)).size > 1000);
    assert.ok(frame.blueBackgroundPercent > 10);

    for (const loop of [true, false]) {
      let request: GenerateVideosParameters | undefined;
      const job = await startAnimation({ title: loop ? 'Seated loop' : 'Unwrapping scene', action: loop ? 'Gently rock while holding the present, then return to the starting pose.' : 'Unwrap the present and reveal a glowing ornament.', imagePath: mascotPath, preparedFrameId: frame.id, loop, durationSeconds: 8 }, async value => {
        request = value;
        return { name: `test-operation-${loop}` } as GenerateVideosOperation;
      });
      jobIds.push(job.id);
      assert.equal(job.preparedFrameId, frame.id);
      assert.equal(job.startFramePrompt, frame.prompt);
      assert.equal(job.startFrameImage, 'start-frame.png');
      const sentImage = request?.source?.image?.imageBytes;
      assert.equal(sentImage, (await readFile(join(jobDir(job.id), 'start-frame.png'))).toString('base64'));
      if (loop) assert.equal(request?.config?.lastFrame?.imageBytes, sentImage);
      else assert.equal(request?.config?.lastFrame, undefined);
    }
  } finally {
    for (const id of jobIds) await rm(jobDir(id), { recursive: true, force: true });
    if (preparedId) await rm(join(libraryRoot, '_prepared', preparedId), { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test('preparation rejects missing image output without submitting a video', async () => {
  await assert.rejects(() => prepareStartFrame({ imagePath: mascotPath, prompt: 'Place the mascot in a seated position.' }, async () => ({ candidates: [{ content: { parts: [{ text: 'No image' }] } }] }) as GenerateContentResponse), /did not return a starting image/);
  const request = buildStartFrameRequest('Put the mascot on a sled.', 'abc', 'image/png');
  assert.match(JSON.stringify(request.contents), /solid chroma-blue #0000FF/);
});
