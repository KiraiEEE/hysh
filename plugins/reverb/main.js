// Room Reverb - example Hysh audio-effect plugin (GPL-3.0-or-later).
// An effect is any Web Audio graph with one input and one output node.

/** Builds a decaying stereo noise burst: a cheap, natural-sounding room impulse response. */
function impulse(ctx, seconds = 2.2, decay = 3) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

export default function activate(hysh) {
  const wetLevel = hysh.storage.get('wet', 0.28);
  hysh.audio.addEffect('room', (ctx) => {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx);
    dry.gain.value = 1 - wetLevel * 0.5;
    wet.gain.value = wetLevel;
    input.connect(dry).connect(output);
    input.connect(convolver).connect(wet).connect(output);
    return { input, output };
  });
  hysh.ui.toast('Room Reverb is on');
}
