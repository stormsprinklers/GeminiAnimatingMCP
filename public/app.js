const notice = document.getElementById('notice');
const jobsEl = document.getElementById('jobs');
const form = document.getElementById('create-form');
const button = document.getElementById('create-button');
const loopInput = document.getElementById('loop');
const loopOptions = document.getElementById('loop-options');
const presetInput = document.getElementById('preset');
const actionInput = document.getElementById('action');
const durationInput = document.getElementById('duration');
const modelInput = document.getElementById('model');
const imageInput = document.getElementById('image');
const referencePreview = document.getElementById('reference-preview');
const startPromptInput = document.getElementById('start-prompt');
const prepareButton = document.getElementById('prepare-button');
const preparedEl = document.getElementById('prepared');
const preparedImage = document.getElementById('prepared-image');
const endOptions = document.getElementById('end-options');
const endPromptInput = document.getElementById('end-prompt');
const prepareEndButton = document.getElementById('prepare-end-button');
const endingPreparedEl = document.getElementById('ending-prepared');
const endingImage = document.getElementById('ending-image');
let jobs = [];
let presets = [];
let preparedFrameId = '';
let endingFrameId = '';

function message(text, kind = '') {
  notice.textContent = text;
  notice.className = `notice ${kind}`;
}
async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(container, label, href, download = false) {
  const a = el('a', '', label); a.href = href; if (download) a.download = ''; container.append(a);
}
function render() {
  jobsEl.replaceChildren();
  if (!jobs.length) { jobsEl.append(el('p', 'empty', 'Your completed animations will appear here.')); return; }
  for (const job of jobs) {
    const card = el('article', 'job');
    const head = el('div', 'job-head');
    head.append(el('h3', '', job.title), el('span', `badge ${job.status}`, job.status));
    card.append(head, el('time', '', new Date(job.createdAt).toLocaleString()));
    if (job.tags?.length) card.append(el('p', '', `Tags: ${job.tags.join(', ')}`));
    if (job.review) card.append(el('p', '', `Review: ${job.review}`));
    if (job.startFramePrompt) {
      card.append(el('p', '', `Starting frame: ${job.startFramePrompt}`));
      const start = el('img', 'start-preview'); start.src = `/api/animations/${job.id}/file/start`; start.alt = 'Prepared starting frame'; card.append(start);
    }
    if (job.endingFramePrompt) {
      card.append(el('p', '', `Ending frame: ${job.endingFramePrompt}`));
      const end = el('img', 'start-preview'); end.src = `/api/animations/${job.id}/file/end`; end.alt = 'Prepared ending frame'; card.append(end);
      if (job.startFrameMatchScore !== undefined) card.append(el('p', '', `Veo match to prepared pictures: start ${job.startFrameMatchScore}% difference · end ${job.endFrameMatchScore}% difference`));
    }
    if (job.loopEnabled) card.append(el('p', '', `Loop · ${job.durationSeconds || '?'}s requested · boundary ${job.firstLastDifferenceScore ?? '?'}% raw / ${job.finalBoundaryDifferenceScore ?? '?'}% final · ${job.correctiveBlendApplied ? `${job.blendFrames}-frame blend` : 'no blend'} · ${job.approvalStatus || 'pending'} approval`));
    if (job.status === 'failed') card.append(el('p', '', job.error || 'Generation failed.'));
    if (job.status === 'generating') card.append(el('p', '', 'Veo is making the animation. This page checks progress automatically.'));
    if (job.status === 'processing') card.append(el('p', '', `Video downloaded. Removing the blue background now.${job.error ? ` Last attempt: ${job.error}` : ''}`));
    if (job.status === 'ready') {
      const video = el('video', 'preview'); video.controls = true; video.loop = !!job.loopEnabled; video.src = `/api/animations/${job.id}/file/${job.loopEnabled ? 'corrected' : 'original'}`; card.append(video);
      const links = el('div', 'links');
      link(links, 'Download transparent WebM', `/api/animations/${job.id}/file/transparent?download=1`, true);
      link(links, 'Download original MP4', `/api/animations/${job.id}/file/original?download=1`, true);
      link(links, job.loopEnabled ? 'Preview continuous loop' : 'Preview animation', `/preview/${job.id}`);
      card.append(links);
    }
    jobsEl.append(card);
  }
}
async function refresh() {
  try {
    jobs = await api('/api/animations');
    const active = jobs.filter(job => job.status === 'generating' || job.status === 'processing');
    if (active.length) {
      const updates = await Promise.all(active.map(job => api(`/api/animations/${job.id}`)));
      jobs = jobs.map(job => updates.find(update => update.id === job.id) || job);
    }
    render();
  } catch (error) { message(error.message, 'error'); }
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read image.')); reader.readAsDataURL(file);
  });
}
form.addEventListener('submit', async event => {
  event.preventDefault(); button.disabled = true; message('Submitting your animation to Veo…');
  try {
    const file = imageInput.files[0];
    if (startPromptInput.value.trim() && !preparedFrameId) throw new Error('Prepare and review the new starting frame before generating the video.');
    if (!loopInput.checked && endPromptInput.value.trim() && !endingFrameId) throw new Error('Prepare and review the ending frame before generating the video.');
    const body = { title: document.getElementById('title').value, action: actionInput.value, loop: loopInput.checked };
    if (loopInput.checked) { body.preset = presetInput.value || undefined; body.durationSeconds = Number(durationInput.value); body.model = modelInput.value; }
    if (preparedFrameId) body.preparedFrameId = preparedFrameId;
    else if (file) body.imageData = await readImage(file);
    if (!loopInput.checked && endingFrameId) body.endingFrameId = endingFrameId;
    const job = await api('/api/animations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    message(`Animation submitted. Job ${job.id} is in your library.`, 'good');
    await refresh();
  } catch (error) { message(error.message, 'error'); }
  finally { button.disabled = false; }
});
function clearEndingFrame() { endingFrameId = ''; endingPreparedEl.hidden = true; endingImage.removeAttribute('src'); }
function clearPreparedFrame() { preparedFrameId = ''; preparedEl.hidden = true; preparedImage.removeAttribute('src'); clearEndingFrame(); }
let uploadedPreviewUrl = '';
imageInput.addEventListener('change', () => {
  clearPreparedFrame();
  if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
  uploadedPreviewUrl = imageInput.files[0] ? URL.createObjectURL(imageInput.files[0]) : '';
  referencePreview.src = uploadedPreviewUrl || '/api/mascot';
});
startPromptInput.addEventListener('input', clearPreparedFrame);
endPromptInput.addEventListener('input', clearEndingFrame);
prepareButton.addEventListener('click', async () => {
  prepareButton.disabled = true; message('Preparing the new starting pose from your mascot image…');
  try {
    const prompt = startPromptInput.value.trim();
    if (prompt.length < 8) throw new Error('Describe the new starting pose or design in at least 8 characters.');
    const body = { prompt };
    if (imageInput.files[0]) body.imageData = await readImage(imageInput.files[0]);
    const prepared = await api('/api/prepared-frames', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    preparedFrameId = prepared.id;
    preparedImage.src = `/api/prepared-frames/${prepared.id}/image`;
    preparedEl.hidden = false;
    message('Starting frame is ready. Check it below, then generate the animation.', 'good');
  } catch (error) { message(error.message, 'error'); }
  finally { prepareButton.disabled = false; }
});
prepareEndButton.addEventListener('click', async () => {
  prepareEndButton.disabled = true; message('Preparing the exact ending pose from both mascot pictures…');
  try {
    if (loopInput.checked) throw new Error('Turn looping off to use a different ending pose.');
    if (!preparedFrameId) throw new Error('Prepare and review a starting frame first.');
    const prompt = endPromptInput.value.trim();
    if (prompt.length < 8) throw new Error('Describe the ending pose in at least 8 characters.');
    const prepared = await api('/api/prepared-frames/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startFrameId: preparedFrameId, prompt, action: actionInput.value }) });
    endingFrameId = prepared.id;
    endingImage.src = `/api/prepared-frames/${prepared.id}/image`;
    endingPreparedEl.hidden = false;
    message('Ending frame is ready. Check both pictures, then generate the animation.', 'good');
  } catch (error) { message(error.message, 'error'); }
  finally { prepareEndButton.disabled = false; }
});
api('/api/setup').then(setup => message(setup.keyReady ? 'Ready to generate. Your API key is loaded and its value is hidden.' : 'Add your Gemini API key to the .env file, save it, then refresh this page.', setup.keyReady ? 'good' : '')).catch(error => message(error.message, 'error'));
api('/api/loop-presets').then(items => { presets = items; for (const preset of items) { const option = el('option', '', preset.label); option.value = preset.id; presetInput.append(option); } }).catch(() => {});
loopInput.addEventListener('change', () => { loopOptions.hidden = !loopInput.checked; endOptions.hidden = loopInput.checked; });
presetInput.addEventListener('change', () => { const preset = presets.find(item => item.id === presetInput.value); if (preset) { actionInput.value = preset.action; durationInput.value = String(preset.durationSeconds); clearEndingFrame(); } });
actionInput.addEventListener('input', () => { presetInput.value = ''; clearEndingFrame(); });
refresh(); setInterval(refresh, 10_000);
