const id = location.pathname.split('/').filter(Boolean).pop();
const title = document.getElementById('title');
const info = document.getElementById('info');
const video = document.getElementById('video');
const switchVideo = document.getElementById('switch-video');
const formatNote = document.getElementById('format-note');
const playbackHelp = document.getElementById('playback-help');
if (!/^[0-9a-f-]{36}$/.test(id)) { title.textContent = 'Invalid animation'; }
else fetch(`/api/animations/${id}`).then(r => r.json()).then(job => {
  if (job.status !== 'ready' || !job.transparentVideo || !job.rawVideo) throw new Error('Animation is not ready.');
  title.textContent = job.title;
  info.textContent = `${job.outputDurationSeconds || job.durationSeconds || '?'} seconds · ${job.loopEnabled ? `looping · boundary difference ${job.finalBoundaryDifferenceScore ?? '?'}%` : 'plays once'}`;
  video.loop = !!job.loopEnabled;
  playbackHelp.textContent = job.loopEnabled ? 'The video repeats continuously. Watch the moment it returns from the end to the beginning for a jump, ghosting, or a speed change.' : 'This animation plays once, from the prepared starting pose to its new ending pose.';
  video.src = `/api/animations/${id}/file/corrected`;
  video.play().catch(() => {});
  let transparent = false;
  switchVideo.addEventListener('click', () => {
    transparent = !transparent;
    video.src = `/api/animations/${id}/file/${transparent ? 'transparent' : 'corrected'}`;
    switchVideo.textContent = transparent ? 'Show original MP4' : 'Show transparent WebM';
    formatNote.textContent = transparent ? 'Playing the transparent WebM. Some browsers cannot play VP9 transparency reliably.' : 'Playing original blue-screen MP4 for reliable playback. The exported WebM has transparent background.';
    video.play().catch(() => {});
  });
}).catch(error => { title.textContent = 'Preview unavailable'; info.textContent = error.message; });
