// Windows regressions: exercise the real contract gate and the source scan it uses.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const trees = [];
function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'tina-gate-portability-'));
  trees.push(dir);
  return dir;
}
after(() => {
  for (const dir of trees) {
    // Delete only freshly created test trees directly inside the resolved OS temp directory.
    assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
    assert(dir.startsWith(join(tmpdir(), 'tina-gate-portability-')));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contract freeze accepts LF/CRLF checkout conversion but rejects actual schema edits', () => {
  const dir = tree();
  const contract = 'core/sample/contracts/sample.v1';
  mkdirSync(join(dir, contract), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/gates.mjs'), join(dir, 'gates.mjs'));
  const schema = '{\n "type": "string"\n}\n';
  const hash = createHash('sha256').update('sample.schema.json\0').update(schema).digest('hex');
  writeFileSync(join(dir, 'contracts.seal.json'), JSON.stringify({ [contract]: hash }));
  const run = () => execFileSync(process.execPath, ['gates.mjs', 'contract-version'],
    { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  for (const value of [schema, schema.replaceAll('\n', '\r\n')]) {
    writeFileSync(join(dir, contract, 'sample.schema.json'), value);
    assert.match(run(), /sealed contract\(s\) frozen/);
  }
  writeFileSync(join(dir, contract, 'sample.schema.json'), schema.replace('string', 'number'));
  assert.throws(run, error => error.status === 1 && error.stderr.includes('sealed contract changed'));
});

test('dataflow source scan sees real files, filters test/build output and fails on scan errors', () => {
  const dir = tree();
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  const files = ['core/demo/src/writer.py', 'clients/demo/src/view.tsx',
    'core/demo/tests/test_writer.py', 'core/demo/eval/writer.py',
    'clients/demo/src/view.test.ts', 'clients/demo/dist/view.ts',
    'clients/demo/node_modules/dependency/index.ts'];
  for (const name of files) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), 'publish("carrier")\n');
  }
  const source = readFileSync(join(ROOT, 'scripts/gates.mjs'), 'utf8');
  const implementation = source.match(/function sourceMatches\(re, filesOnly = false\) \{[\s\S]*?\n\}/);
  assert(implementation, 'dataflow source scanner missing');
  const scan = new Function('execFileSync', 'ROOT', `${implementation[0]}; return sourceMatches;`)(execFileSync, dir);
  assert.deepEqual(scan('publish', true).sort(), ['clients/demo/src/view.tsx', 'core/demo/src/writer.py']);
  assert.equal(scan('publish').length, 2);
  assert.deepEqual(scan('no_such_symbol'), []);
  assert.throws(() => scan('[')); // invalid regex is an engine failure, never a clean no-match
});
