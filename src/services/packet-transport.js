const MAGIC_1 = 0x4d;
const MAGIC_2 = 0x43;
const HEADER_SIZE = 8;
const MAX_FRAME_SIZE = 255;

function assertFrameSize(frameSize) {
  if (
    !Number.isInteger(frameSize) ||
    frameSize <= HEADER_SIZE ||
    frameSize > MAX_FRAME_SIZE
  ) {
    throw new Error('Invalid BLE frame size.');
  }
}

export class PacketTransport {
  constructor({
    frameSize = 20,
    maxPacketBytes = 3000,
    maxAssembliesPerPeer = 8,
    ttlMs = 30000
  } = {}) {
    assertFrameSize(frameSize);

    // frameSize is the default size used when sending. Incoming frames may be
    // larger, up to the BLE maximum, because the sender negotiates its own MTU.
    this.frameSize = frameSize;
    this.payloadSize = frameSize - HEADER_SIZE;
    this.maxPacketBytes = maxPacketBytes;
    this.maxAssembliesPerPeer = maxAssembliesPerPeer;
    this.ttlMs = ttlMs;
    this.assemblies = new Map();
  }

  fragment(input, frameSize = this.frameSize) {
    assertFrameSize(frameSize);
    const payloadSize = frameSize - HEADER_SIZE;

    const bytes = input instanceof Uint8Array
      ? input
      : new TextEncoder().encode(String(input));

    if (!bytes.length || bytes.length > this.maxPacketBytes) {
      throw new Error('Packet is empty or exceeds the maximum size.');
    }

    const total = Math.ceil(bytes.length / payloadSize);

    if (total > 255) {
      throw new Error('Packet requires too many fragments.');
    }

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const packetId = random[0];

    const frames = [];

    for (let index = 0; index < total; index++) {
      const start = index * payloadSize;
      const payload = bytes.slice(start, start + payloadSize);
      const frame = new Uint8Array(HEADER_SIZE + payload.length);

      frame[0] = MAGIC_1;
      frame[1] = MAGIC_2;
      frame[2] = (packetId >>> 24) & 0xff;
      frame[3] = (packetId >>> 16) & 0xff;
      frame[4] = (packetId >>> 8) & 0xff;
      frame[5] = packetId & 0xff;
      frame[6] = index;
      frame[7] = total;
      frame.set(payload, HEADER_SIZE);

      frames.push(frame);
    }

    return frames;
  }

  accept(peerId, frame, now = Date.now()) {
    if (!peerId || !(frame instanceof Uint8Array)) {
      throw new Error('Invalid packet input.');
    }

    this.cleanup(now);

    if (
      frame.length <= HEADER_SIZE ||
      frame.length > MAX_FRAME_SIZE ||
      frame[0] !== MAGIC_1 ||
      frame[1] !== MAGIC_2
    ) {
      throw new Error('Invalid BLE frame header.');
    }

    const packetId =
      ((frame[2] * 0x1000000) +
       (frame[3] << 16) +
       (frame[4] << 8) +
       frame[5]) >>> 0;

    const index = frame[6];
    const total = frame[7];

    if (!total || index >= total) {
      throw new Error('Invalid BLE fragment metadata.');
    }

    const key = `${peerId}:${packetId}`;
    let assembly = this.assemblies.get(key);

    if (!assembly) {
      const peerCount = [...this.assemblies.keys()]
        .filter(k => k.startsWith(`${peerId}:`)).length;

      if (peerCount >= this.maxAssembliesPerPeer) {
        throw new Error('Too many incomplete packets from this peer.');
      }

      assembly = {
        total,
        chunks: new Array(total),
        received: 0,
        size: 0,
        updatedAt: now
      };

      this.assemblies.set(key, assembly);
    }

    if (assembly.total !== total) {
      this.assemblies.delete(key);
      throw new Error('Inconsistent BLE fragment count.');
    }

    const payload = frame.slice(HEADER_SIZE);
    const previous = assembly.chunks[index];

    if (previous) {
      if (
        previous.length !== payload.length ||
        previous.some((byte, i) => byte !== payload[i])
      ) {
        this.assemblies.delete(key);
        throw new Error('Conflicting duplicate BLE fragment.');
      }

      return null;
    }

    assembly.chunks[index] = payload;
    assembly.received++;
    assembly.size += payload.length;
    assembly.updatedAt = now;

    if (assembly.size > this.maxPacketBytes) {
      this.assemblies.delete(key);
      throw new Error('Reassembled packet exceeds the size limit.');
    }

    if (assembly.received !== assembly.total) return null;

    const result = new Uint8Array(assembly.size);
    let offset = 0;

    for (const chunk of assembly.chunks) {
      if (!chunk) return null;
      result.set(chunk, offset);
      offset += chunk.length;
    }

    this.assemblies.delete(key);
    return result;
  }

  cleanup(now = Date.now()) {
    for (const [key, assembly] of this.assemblies) {
      if (now - assembly.updatedAt > this.ttlMs) {
        this.assemblies.delete(key);
      }
    }
  }
}
