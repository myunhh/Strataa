import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bridge = path.resolve(import.meta.dirname, '../skills/strataa-paper-orchestra/bridge.py');
function inputs(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'strataa-paper-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'idea.md'), '기여와 범위\r\n');
  writeFileSync(path.join(root, 'log.md'), 'A, 43.43\nB, 34.20\n');
  const figures = path.join(root, 'figures');
  mkdirSync(figures);
  const save = entries => writeFileSync(path.join(figures, 'info.json'), JSON.stringify(entries));
  const pack = () => spawnSync('python3', [bridge, 'prepare', '--idea', 'idea.md', '--log', 'log.md', '--figures', 'figures', '--out', 'out'], { cwd: root, encoding: 'utf8' });
  return { root, figures, save, pack };
}

test('a manuscript pack contains the exact narrative bytes and only the approved figures', t => {
  const { root, figures, save, pack } = inputs(t);
  writeFileSync(path.join(figures, 'result.JPEG'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(path.join(figures, 'unapproved.png'), 'not for this writer');
  writeFileSync(path.join(root, 'metrics.csv'), 'original reviewer data');
  save([{ name: 'result.JPEG', caption: 'A lower score is better.' }]);
  const proc = pack();
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout).materials;
  assert.deepEqual(readdirSync(out).sort(), ['experimental_log.md', 'figures', 'idea_sparse.md']);
  assert.deepEqual(readFileSync(path.join(out, 'idea_sparse.md')), readFileSync(path.join(root, 'idea.md')));
  assert.deepEqual(readFileSync(path.join(out, 'experimental_log.md')), readFileSync(path.join(root, 'log.md')));
  assert.deepEqual(readdirSync(path.join(out, 'figures')).sort(), ['info.json', 'result.jpg']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'figures/info.json'))), [{ name: 'result.jpg', caption: 'A lower score is better.' }]);
  assert.notEqual(pack().status, 0);
  assert.deepEqual(readFileSync(path.join(out, 'figures/result.jpg')), readFileSync(path.join(figures, 'result.JPEG')));
});

test('manifest traversal and linked assets cannot include files outside the writing pack', t => {
  const { root, figures, save, pack } = inputs(t);
  writeFileSync(path.join(root, 'private.png'), 'unapproved');
  symlinkSync(path.join(root, 'private.png'), path.join(figures, 'alias.png'));
  for (const name of ['../private.png', 'alias.png']) {
    save([{ name, caption: '' }]);
    const proc = pack();
    assert.notEqual(proc.status, 0);
    assert.equal(existsSync(path.join(root, 'out')), false);
  }
});
