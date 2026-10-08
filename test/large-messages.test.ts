import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, CAP, PAGE, bytes, flat } from '../src/memory.ts';

const withMemory = async (run: (memory: Memory, dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-large-'));
  const memory = new Memory(dir, async input => `${input.source.split(':')[0]}: gist of it`, () => {});
  try { await run(memory, dir); } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
};
const lines = (memory: Memory) => memory.render().split('\n').slice(1, -1);

test('only a leaf over 8 KB names its size, also after a restart, and the view counts the tag', async () => {
  await withMemory(async (memory, dir) => {
    memory.append('echo', 'x'.repeat(7_900));
    memory.append('user', 'y'.repeat(31_000));
    memory.append('talk', 'short reply');
    await memory.settle(AbortSignal.timeout(5000), true);
    assert.deepEqual(lines(memory), ['0+1|echo: gist of it', '1+1|user (31 KB): gist of it', '2+1|talk: short reply']);
    assert.equal(memory.size, lines(memory).reduce((sum, line) => sum + bytes(flat(line.slice(line.indexOf('|') + 1))), 0));
    const reloaded = new Memory(dir, async () => 'unused', () => {});
    try { assert.deepEqual(lines(reloaded), lines(memory)); assert.equal(reloaded.size, memory.size); }
    finally { await reloaded.close(); }
  });
});

test('zoom pages a long message without splitting characters, and leaves short ones whole', async () => {
  await withMemory(async memory => {
    memory.append('user', 'short');
    const long = 'a'.repeat(PAGE - 1) + '😀' + 'b'.repeat(40_000);
    memory.append('user', long);
    assert.equal(memory.zoom(0, 1), '0+0|user: short');
    let text = '', offset: number | undefined;
    for (let pages = 0; pages < 3; pages++) {
      const page = memory.zoom(1, 1, offset);
      assert.ok(page.length <= CAP);
      const [, body, from, to] = /^1\+0\|user: ([\s\S]*)\n\[showing characters (\d+)-(\d+) of 65001/.exec(page)!;
      assert.equal(Number(from), text.length);
      text += body; offset = Number(to);
    }
    assert.equal(text, long);
    assert.match(memory.zoom(1, 1, PAGE), /^1\+0\|user: 😀b/);
    assert.match(memory.zoom(1, 1, 10, 5), /^1\+0\|user: a{5}\n\[showing characters 10-15 of 65001; next page: offset 15\]$/);
    assert.throws(() => memory.zoom(1, 1, long.length), /offset must be 0 to 65000/);
    assert.throws(() => memory.zoom(0, 2, 0), /n = 1/);
  });
});
