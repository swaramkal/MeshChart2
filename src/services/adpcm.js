// IMA ADPCM codec: 16-bit PCM -> 4 bits per sample (4:1). Each frame carries its
// own predictor and step index, so a lost or dropped frame never corrupts the
// next one. A 20 ms / 16 kHz frame (640 bytes of PCM) becomes 163 bytes.

const STEPS = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];

export const SAMPLES_PER_FRAME = 320;
export const PCM_FRAME_BYTES = SAMPLES_PER_FRAME * 2;
export const ADPCM_FRAME_BYTES = 3 + Math.ceil((SAMPLES_PER_FRAME - 1) / 2);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeSample(sample, state) {
  const step = STEPS[state.index];
  let diff = sample - state.predictor;
  let code = 0;
  if (diff < 0) { code = 8; diff = -diff; }
  let delta = step >> 3;
  if (diff >= step) { code |= 4; diff -= step; delta += step; }
  if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
  if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
  state.predictor = clamp(state.predictor + (code & 8 ? -delta : delta), -32768, 32767);
  state.index = clamp(state.index + INDEX_ADJUST[code & 7], 0, 88);
  return code;
}

function decodeSample(code, state) {
  const step = STEPS[state.index];
  let delta = step >> 3;
  if (code & 4) delta += step;
  if (code & 2) delta += step >> 1;
  if (code & 1) delta += step >> 2;
  state.predictor = clamp(state.predictor + (code & 8 ? -delta : delta), -32768, 32767);
  state.index = clamp(state.index + INDEX_ADJUST[code & 7], 0, 88);
  return state.predictor;
}

// pcm: Uint8Array of 640 little-endian int16 bytes -> Uint8Array(163)
// carry: optional { index } object. The step index reached at the end of a frame
// is stored there so the next frame starts adapted (header still makes each
// frame independently decodable).
export function encodeFrame(pcm, carry = { index: 0 }) {
  if (!(pcm instanceof Uint8Array) || pcm.length !== PCM_FRAME_BYTES) throw new Error('Unexpected audio frame size.');
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const out = new Uint8Array(ADPCM_FRAME_BYTES);
  const first = view.getInt16(0, true);
  const state = { predictor: first, index: clamp(carry.index | 0, 0, 88) };
  out[0] = first & 0xff; out[1] = (first >> 8) & 0xff; out[2] = state.index;
  for (let i = 1; i < SAMPLES_PER_FRAME; i++) {
    const code = encodeSample(view.getInt16(i * 2, true), state);
    const pos = 3 + ((i - 1) >> 1);
    out[pos] |= (i - 1) & 1 ? code << 4 : code;
  }
  carry.index = state.index;
  return out;
}

export function decodeFrame(data) {
  if (!(data instanceof Uint8Array) || data.length !== ADPCM_FRAME_BYTES) throw new Error('Unexpected compressed frame size.');
  const index = data[2];
  if (index > 88) throw new Error('Invalid compressed frame.');
  const first = (data[0] | (data[1] << 8)) << 16 >> 16;
  const state = { predictor: first, index };
  const out = new Uint8Array(PCM_FRAME_BYTES);
  const view = new DataView(out.buffer);
  view.setInt16(0, first, true);
  for (let i = 1; i < SAMPLES_PER_FRAME; i++) {
    const byte = data[3 + ((i - 1) >> 1)];
    const code = (i - 1) & 1 ? byte >> 4 : byte & 0x0f;
    view.setInt16(i * 2, decodeSample(code, state), true);
  }
  return out;
}
