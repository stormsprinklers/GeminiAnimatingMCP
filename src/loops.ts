export const LOOP_REQUIREMENTS = 'The character performs exactly one complete cyclic motion and returns precisely to the original pose. The final frame must visually match the first frame, including the character’s position, scale, expression, body posture, clothing, tail position, lighting, illustration style, and background. Keep the camera completely static. Do not zoom, pan, rotate, crop, or reposition the character. The animation must play continuously without a visible jump, pause, or change in speed at the loop boundary.';

export const FIRST_REAL_LOOP_PROMPT = 'Animate the exact Chestnut & Cheer chipmunk mascot performing one gentle idle cycle. He breathes subtly, blinks once, smiles warmly, and makes one small natural tail movement before returning exactly to his original neutral pose. Preserve the exact character design, colors, clothing, proportions, facial features, illustration style, and full-body composition. Keep his feet and body anchored in exactly the same position. Use a locked static camera. The background must remain perfectly solid chroma blue #0000FF with no shadows, gradients, reflections, scenery, text, particles, or camera movement. The final frame must match the first frame precisely so the animation loops continuously without a jump, pause, hesitation, or speed change.';

export const LOOP_PRESETS = [
  { id: 'idle', label: 'Idle breathing and blinking', durationSeconds: 4, action: 'One gentle idle cycle: breathe subtly, blink once, and make one small tail movement, returning to the exact neutral pose.' },
  { id: 'talking', label: 'Talking hand gestures', durationSeconds: 6, action: 'One natural talking gesture cycle with the free paw and a small mouth movement, returning to the exact neutral pose. No spoken words.' },
  { id: 'listening', label: 'Listening and nodding', durationSeconds: 4, action: 'One attentive listening cycle: tilt slightly, nod once, and return to the exact neutral pose.' },
  { id: 'thinking', label: 'Thinking', durationSeconds: 6, action: 'One thoughtful cycle: glance upward, touch chin with the free paw, then return to the exact neutral pose.' },
  { id: 'waving', label: 'Waving', durationSeconds: 4, action: 'Wave the free paw once in a complete wave cycle, then return to the exact neutral pose.' },
  { id: 'pointing-left', label: 'Pointing left', durationSeconds: 4, action: 'Point the free paw toward screen left once, then return to the exact neutral pose.' },
  { id: 'pointing-right', label: 'Pointing right', durationSeconds: 4, action: 'Point the free paw toward screen right once, then return to the exact neutral pose.' },
  { id: 'tail', label: 'Tail movement', durationSeconds: 4, action: 'Make one gentle tail swish cycle and return the tail to its exact original position.' },
  { id: 'celebrating', label: 'Celebrating', durationSeconds: 6, action: 'Make one small joyful celebration gesture, then return to the exact neutral pose.' },
  { id: 'walking', label: 'Walking in place', durationSeconds: 8, action: 'Walk in place for exactly one complete gait cycle while the body stays anchored, then return to the exact starting pose.' }
] as const;

export function loopPreset(id: string | undefined): (typeof LOOP_PRESETS)[number] | undefined {
  return LOOP_PRESETS.find(preset => preset.id === id);
}
