import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateContentParameters, GenerateContentResponse, GenerateVideosOperation, GenerateVideosParameters } from '@google/genai';
import { libraryRoot, mascotPath } from './config.js';
import { jobDir } from './library.js';
import { startAnimation } from './pipeline.js';
import { buildStartFrameRequest, getPreparedFrame, prepareEndingFrame, prepareStartFrame, START_FRAME_MODEL } from './start-frame.js';
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

test('a separate ending picture is tied to its start and sent to Veo as lastFrame', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ending-mascot-'));
  const preparedIds: string[] = [];
  const jobIds: string[] = [];
  try {
    const edited = join(temp, 'edited.png');
    await prepareReference(mascotPath, edited);
    const startBytes = (await readFile(edited)).toString('base64');
    const endBytes = (await readFile(mascotPath)).toString('base64');
    const start = await prepareStartFrame({ imagePath: mascotPath, prompt: 'Seat the mascot with a wrapped Christmas present.' }, async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: startBytes, mimeType: 'image/png' } }] } }] }) as GenerateContentResponse);
    preparedIds.push(start.id);
    const motion = 'Open the present while staying seated.';
    let editRequest: GenerateContentParameters | undefined;
    const end = await prepareEndingFrame({ startFrameId: start.id, prompt: 'Stay seated and hold the open present with a joyful smile.', motionPrompt: motion }, async request => {
      editRequest = request;
      return { candidates: [{ content: { parts: [{ inlineData: { data: endBytes, mimeType: 'image/png' } }] } }] } as GenerateContentResponse;
    });
    preparedIds.push(end.id);
    assert.equal(end.role, 'end');
    assert.equal(end.parentFrameId, start.id);
    assert.equal(end.motionPrompt, motion);
    assert.equal(editRequest?.model, START_FRAME_MODEL);
    assert.equal(JSON.stringify(editRequest?.contents).match(/inlineData/g)?.length, 2);
    assert.match(JSON.stringify(editRequest?.contents), /Stay seated/);
    assert.notEqual((await readFile((await getPreparedFrame(start.id)).startFramePath)).toString('base64'), (await readFile((await getPreparedFrame(end.id)).startFramePath)).toString('base64'));

    let videoRequest: GenerateVideosParameters | undefined;
    const job = await startAnimation({ title: 'Gift with controlled ending', action: motion, imagePath: mascotPath, preparedFrameId: start.id, endingFrameId: end.id, loop: false }, async request => {
      videoRequest = request;
      return { name: 'test-two-frame-operation' } as GenerateVideosOperation;
    });
    jobIds.push(job.id);
    assert.equal(job.lastFrameAccepted, true);
    assert.equal(job.endingFrameId, end.id);
    assert.match(job.prompt, /separately supplied ending frame/);
    assert.equal(videoRequest?.source?.image?.imageBytes, (await readFile(join(jobDir(job.id), 'start-frame.png'))).toString('base64'));
    assert.equal(videoRequest?.config?.lastFrame?.imageBytes, (await readFile(join(jobDir(job.id), 'end-frame.png'))).toString('base64'));
    assert.notEqual(videoRequest?.source?.image?.imageBytes, videoRequest?.config?.lastFrame?.imageBytes);
    await assert.rejects(() => startAnimation({ title: 'Bad loop', action: motion, imagePath: mascotPath, preparedFrameId: start.id, endingFrameId: end.id, loop: true }, async () => ({ name: 'none' }) as GenerateVideosOperation), /must end on its starting frame/);
  } finally {
    for (const id of jobIds) await rm(jobDir(id), { recursive: true, force: true });
    for (const id of preparedIds) await rm(join(libraryRoot, '_prepared', id), { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});
