'use strict';
// The command-line tool: the page's worker core run from Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers');
const NX = require('./nexus-fixtures');

const CLI = path.join(H.ROOT, 'cli', '3dsconvert.js');
const example = name => path.join(H.ROOT, 'Examples', name);
const work = fs.mkdtempSync(path.join(os.tmpdir(), '3dsconvert-cli-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

function cli(...args) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

test('cli: --help, and bad options stop with a message', () => {
    const help = cli('--help');
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: node cli\/3dsconvert\.js INPUT\.\.\. --to FORMAT/);
    const bad = cli(example('example_unified.h5'), '--to', 'xyz');
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--to must be one of unified, yell/);
    assert.match(cli(example('example_unified.h5'), '--to', 'yell', '--frobnicate').err, /unknown option --frobnicate/);
    assert.match(cli(example('nothing.h5'), '--to', 'yell').err, /no such file/);
});

test('cli: unified -> Yell with the same values; no overwrite without --force', async () => {
    const dir = path.join(work, 'yell');
    const r = cli(example('example_unified.h5'), '--to', 'yell', '-d', dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /example_unified\.h5: unified \| grid 5 x 5 x 5/);
    const out = path.join(dir, 'example_unified_yell.h5');
    const got = await H.Converter.readYell(await H.openH5Bytes(fs.readFileSync(out)));
    const ref = await H.Converter.readUnifiedData(await H.openH5('Examples/example_unified.h5'));
    assert.equal(H.maxAbsDiff(got.values, ref.values), 0);
    const again = cli(example('example_unified.h5'), '--to', 'yell', '-d', dir);
    assert.equal(again.code, 1);
    assert.match(again.err, /exists \(use --force to overwrite\)/);
    assert.equal(cli(example('example_unified.h5'), '--to', 'yell', '-d', dir, '-f').code, 0);
});

test('cli: a series converts file by file; one bad file does not stop the others', async () => {
    const dir = path.join(work, 'series');
    const bad = path.join(work, 'bad.txt');
    fs.writeFileSync(bad, 'not a volume\n');
    const r = cli(example('example_unified.h5'), bad, example('example_yell.h5'), '--to', 'npz', '-d', dir, '--crop', 'h=-0.5:0.5');
    assert.equal(r.code, 1);
    assert.match(r.err, /\[2\/3\] bad\.txt: error:/);
    assert.match(r.err, /2 of 3 converted/);
    for (const name of ['example_unified.npz', 'example_yell.npz']) {
        const m = H.Converter.readNpz(fs.readFileSync(path.join(dir, name)));
        assert.deepEqual(m.dims, [3, 5, 5]);                     // cropped on read
    }
});

test('cli: a recipe with a 3D-ΔPDF, written as a CCP4/MRC map', () => {
    const recipe = path.join(work, 'dpdf.json');
    fs.writeFileSync(recipe, JSON.stringify({ version: 1, steps: [{ op: 'symmetrize', laue: 'm-3m' }, { op: 'deltaPdf' }] }));
    const out = path.join(work, 'map.mrc');
    const r = cli(example('example_unified.h5'), '--to', 'mrc', '--recipe', recipe, '-o', out);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /FFT of 5 x 5 x 5 on the CPU/);
    const u = fs.readFileSync(out);
    assert.equal(u.readInt32LE(12), 2);
    assert.equal(u.toString('latin1', 208, 212), 'MAP ');
    // an MRC map of Q-space data is refused before anything is written
    const q = cli(example('example_unified.h5'), '--to', 'mrc', '-o', path.join(work, 'q.mrc'));
    assert.equal(q.code, 1);
    assert.match(q.err, /CCP4\/MRC maps hold direct-space grids/);
    assert.equal(fs.existsSync(path.join(work, 'q.mrc')), false);
});

test('cli: Q-space text in, the cell from --cell or a subhkl --structure', async () => {
    const vti = path.join(work, 'd.vti');
    const r = cli(example('example_diffuse3d.dat'), '--to', 'vti', '--cell', '5.63,5.63,5.63,90,90,90', '-o', vti);
    assert.equal(r.code, 0, r.err);
    assert.match(fs.readFileSync(vti, 'utf8').slice(0, 400), /<ImageData WholeExtent="[^"]+" Origin="[^"]+" Spacing="[^"]+" Direction="/);
    const indexer = path.join(work, 'indexer.h5');
    const f = await NX.subhklFile();
    fs.writeFileSync(indexer, (await H.loadH5wasm()).FS.readFile(f.filename));
    f.close();
    const out = path.join(work, 'd.h5');
    const s = cli(example('example_diffuse3d.dat'), '--to', 'unified', '--structure', indexer, '-o', out);
    assert.equal(s.code, 0, s.err);
    assert.match(s.err, /Structure indexer\.h5: cell 8\.1 8\.1 8\.1/);
    const m = await H.Converter.readUnifiedData(await H.openH5Bytes(fs.readFileSync(out)));
    assert.deepEqual(m.cellLengths, [8.1, 8.1, 8.1]);
    // without a cell, Q-space input is refused
    assert.match(cli(example('example_diffuse3d.dat'), '--to', 'unified', '-o', path.join(work, 'x.h5')).err, /cell/i);
    // a cell file given as the input points to --structure
    assert.match(cli(indexer, '--to', 'unified', '-d', work).err, /holds a unit cell, not a volume; pass it with --structure/);
});

test('cli: streamed text (hkl list for Spinteract, binary VTK)', () => {
    const dir = path.join(work, 'text');
    const r = cli(example('example_unified.h5'), '--to', 'hkl', '-d', dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /grid for the Spinteract config:\n {4}ORIGIN -1 -1 -1/);
    const rows = fs.readFileSync(path.join(dir, 'example_unified_xtal_data_01.txt'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 125);
    const v = cli(example('example_unified.h5'), '--to', 'vtk', '--vtk-binary', '-d', dir);
    assert.equal(v.code, 0, v.err);
    const bytes = fs.readFileSync(path.join(dir, 'example_unified_diffuse.vtk'));
    const grid = H.Converter.readVtkBinary(bytes);
    assert.deepEqual(grid.dims, [5, 5, 5]);
});

test('cli: --zero-empty reads the zeros of an RMCProfile .dat as no data', () => {
    const rows = ['8 1'];
    let n = 0;
    for (let k = 1; k <= 2; k++) for (let j = 1; j <= 2; j++) for (let i = 1; i <= 2; i++) {
        rows.push(`${i} ${j} ${k} ${0.5 * i} ${0.5 * j} ${0.5 * k} ${n++ === 3 ? 0 : n}`);
    }
    const dat = path.join(work, 'zeros.dat');
    fs.writeFileSync(dat, rows.join('\n') + '\n');
    const nan = file => Array.from(H.Converter.readNpz(fs.readFileSync(file)).values).filter(x => Number.isNaN(x)).length;
    const plain = path.join(work, 'zeros_plain.npz'), empty = path.join(work, 'zeros_empty.npz');
    assert.equal(cli(dat, '--to', 'npz', '--cell', '4,4,4,90,90,90', '-o', plain).code, 0);
    const r = cli(dat, '--to', 'npz', '--cell', '4,4,4,90,90,90', '--zero-empty', '-o', empty);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /1 voxels holding 0 read as no data/);
    assert.deepEqual([nan(plain), nan(empty)], [0, 1]);
});
