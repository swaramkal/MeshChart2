import test from 'node:test';
import assert from 'node:assert/strict';
import { PacketTransport } from '../src/services/packet-transport.js';

const decoder = new TextDecoder();

test('fragments and reassembles a message in reverse order', () => {
  const transport = new PacketTransport();
  const original = 'MeshChat offline message '.repeat(12);
  const frames = transport.fragment(original);

  assert.ok(frames.length > 1);
  assert.ok(frames.every(frame => frame.length <= 20));

  let result = null;

  for (const frame of [...frames].reverse()) {
    result = transport.accept('peer-a', frame) || result;
  }

  assert.equal(decoder.decode(result), original);
});

test('uses an eight-byte header and 32-bit packet ID', () => {
  const transport = new PacketTransport();
  const frames = transport.fragment('packet identity test');

  assert.equal(frames[0].length, 20);
  assert.ok(frames[0][2] !== undefined);
  assert.ok(frames[0][5] !== undefined);
});

test('does not complete an incomplete packet', () => {
  const transport = new PacketTransport();
  const frames = transport.fragment('A'.repeat(100));

  assert.equal(transport.accept('peer-a', frames[0]), null);
});

test('ignores an identical duplicate fragment', () => {
  const transport = new PacketTransport();
  const frames = transport.fragment('B'.repeat(100));

  assert.equal(transport.accept('peer-a', frames[0]), null);
  assert.equal(transport.accept('peer-a', frames[0]), null);
});

test('rejects malformed frames', () => {
  const transport = new PacketTransport();

  assert.throws(
    () => transport.accept('peer-a', new Uint8Array([1, 2, 3])),
    /Invalid BLE frame/
  );
});

test('rejects empty and oversized packets', () => {
  const transport = new PacketTransport({ maxPacketBytes: 100 });

  assert.throws(() => transport.fragment(''), /empty/);
  assert.throws(() => transport.fragment('X'.repeat(101)), /maximum size/);
});

test('expires incomplete packet assemblies', () => {
  const transport = new PacketTransport({ ttlMs: 100 });
  const frames = transport.fragment('C'.repeat(100));

  transport.accept('peer-a', frames[0], 1000);
  transport.cleanup(1200);

  assert.equal(transport.assemblies.size, 0);
});

test('isolates assemblies belonging to different peers', () => {
  const transport = new PacketTransport();
  const frames = transport.fragment('D'.repeat(100));

  assert.equal(transport.accept('peer-a', frames[0]), null);
  assert.equal(transport.accept('peer-b', frames[1]), null);
  assert.equal(transport.assemblies.size, 2);
});

test('rejects frames larger than the BLE maximum', () => {
  const transport = new PacketTransport();
  const oversized = new Uint8Array(256);
  oversized[0] = 0x4d;
  oversized[1] = 0x43;

  assert.throws(
    () => transport.accept('peer-a', oversized),
    /Invalid BLE frame/
  );
});

test('uses the negotiated MTU for larger frames and still reassembles', () => {
  const sender = new PacketTransport();
  const receiver = new PacketTransport();
  const original = 'negotiated MTU payload '.repeat(100);

  const small = sender.fragment(original);
  const large = sender.fragment(original, 244);

  assert.ok(large.length < small.length / 10);
  assert.ok(large.every(frame => frame.length <= 244));

  let result = null;
  for (const frame of large) {
    result = receiver.accept('peer-a', frame) || result;
  }

  assert.equal(decoder.decode(result), original);
});

test('rejects an invalid per-call frame size', () => {
  const transport = new PacketTransport();

  assert.throws(() => transport.fragment('hello', 8), /Invalid BLE frame size/);
  assert.throws(() => transport.fragment('hello', 300), /Invalid BLE frame size/);
});

test('a 2.9 KB packet needs about a dozen frames at the 247-byte MTU', () => {
  const transport = new PacketTransport();
  const frames = transport.fragment('x'.repeat(2900), 244);

  assert.ok(frames.length <= 13);
});
