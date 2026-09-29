'use strict';
// Phase 4 formats: hkl lists, and the other readers and writers added with them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Converter, readText } = require('./helpers');

// A 4 x 3 x 2 hkl grid with values 100 ih + 10 ik + il and sigma = 1 + ih.
function sample(withSigma) {
    const dims = [4, 3, 2], values = new Float64Array(24), sigma = new Float64Array(24);
    for (let il = 0, i = 0; il < 2; il++) for (let ik = 0; ik < 3; ik++) for (let ih = 0; ih < 4; ih++, i++) {
        values[i] = 100 * ih + 10 * ik + il;
        sigma[i] = 1 + ih;
    }
    return {
        dims, corner: [-1, 0, 0.5], vectors: [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 1]], values,
        sigma: withSigma ? sigma : undefined, axes: [1, 2, 3], axesType: 'hkl',
        cellLengths: [4, 4, 4], cellAngles: [90, 90, 90],
    };
}

const writeText = (model, report) => Array.from(Converter.writeHklListChunks(model, report)).join('');

test('hkl list: write, then read back onto the same grid, holes and sigma included', () => {
    const m = sample(true);
    m.values[5] = NaN;                                          // a masked voxel is left out
    let report;
    const text = writeText(m, r => { report = r; });
    assert.deepEqual(report, { written: 23, noSigma: false, badSigma: 0 });
    assert.equal(text.split('\n')[0], '-1 0 0.5 0.00000000 1.00000');
    assert.ok(Converter.isHklList(text));
    const back = Converter.hklListModel(Converter.parseHklList(text));
    assert.deepEqual(back.dims, m.dims);
    assert.deepEqual(back.corner, m.corner);
    assert.deepEqual(back.vectors, m.vectors);
    for (let i = 0; i < 24; i++) {
        if (i === 5) assert.ok(Number.isNaN(back.values[i]));
        else assert.ok(Math.abs(back.values[i] - m.values[i]) < 1e-6 && Math.abs(back.sigma[i] - m.sigma[i]) < 1e-5);
    }
    assert.match(back.notes.join('\n'), /1 of 24 grid points have no row/);
});

test('hkl list: sigma 1 when the model has none; non-positive sigma rows are left out', () => {
    let report;
    const plain = writeText(sample(false), r => { report = r; });
    assert.equal(report.noSigma, true);
    assert.ok(plain.trim().split('\n').every(row => row.endsWith(' 1.00000')));
    const m = sample(true);
    m.sigma[3] = 0;
    m.sigma[4] = NaN;
    writeText(m, r => { report = r; });
    assert.deepEqual(report, { written: 22, noSigma: false, badSigma: 2 });
    const four = Converter.parseHklList('1 2 3 4.5\n1.5 2 3 5.5\n');
    assert.equal(four.sigma, null);
    assert.match(Converter.hklListModel(four).notes.join('\n'), /no uncertainties/);
});

test('hkl list: a rotated grid is sparse on h, k, l axes; its config gives the real grid', () => {
    // points on X_AXIS 1 1 0 / Y_AXIS 0 0 1 steps, as a Spinteract config gives them
    const rows = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) rows.push(`${0.25 * i} ${0.25 * i} ${0.5 * j} ${10 * i + j} 1`);
    const list = Converter.parseHklList(rows.join('\n'));
    const inferred = Converter.hklListModel(list);
    assert.deepEqual(inferred.dims, [4, 4, 3]);                  // right hkl for each point, most voxels empty
    assert.match(inferred.notes.join('\n'), /36 of 48 grid points have no row/);
    assert.throws(() => Converter.hklListModel(Converter.parseHklList('0 0 0 1 1\n0.3 0 0 1 1\n0.5 0 0 1 1\n')), /not evenly spaced/);
    const cfg = Converter.parseGridConfig('ORIGIN 0 0 0\nX_AXIS 0.75 0.75 0 4\nY_AXIS 0 0 1 3\nZ_AXIS 0 0 0 1\n');
    const m = Converter.hklListModel(list, cfg.grids[0]);
    assert.deepEqual(m.dims, [4, 3, 1]);
    assert.equal(m.values[(2 * 4) + 3], 32);
});

test('hkl lists and old-format .dat files are told apart', () => {
    assert.equal(Converter.isHklList('125 1\n1 1 1 0.1 0.2 0.3 5\n'), false);
    assert.equal(Converter.isHklList(readText('Examples/example_diffuse3d.dat')), false);
    assert.equal(Converter.isHklList('  -2.4  -3.0  -3.0   1.604   1.0\n  -2.36 -3.0 -3.0 1.412 1.0\n'), true);
    assert.throws(() => Converter.parseHklList('1 2 3 4 5\n1 2 3\n'), /row 2 has 3 columns/);
});

test('hkl list config snippets: Spinteract ORIGIN + full axes, Scatty CENTRE + half axes', () => {
    const m = sample(false);
    m.dims = [5, 3, 1];
    m.vectors = [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 0]];
    assert.equal(Converter.hklConfigSnippet(m, 'spinteract'),
        'ORIGIN -1 0 0.5\nX_AXIS 2 0 0 5\nY_AXIS 0 0.5 0 3\nZ_AXIS 0 0 0 1');
    assert.equal(Converter.hklConfigSnippet(m, 'scatty'),
        'CENTRE 0 0.25 0.5\nX_AXIS 1 0 0 2\nY_AXIS 0 0.25 0 1\nZ_AXIS 0 0 0 0');
    // the snippet reads back as the same grid
    const back = Converter.parseGridConfig(Converter.hklConfigSnippet(m, 'scatty')).grids[0];
    assert.deepEqual(back.dims, [5, 3, 1]);
    assert.deepEqual(back.corner, [-1, 0, 0.5]);
});

const streamOf = text => new Blob([text]).stream();

test('RMCProfile amplitude files: |A|^2 averaged over the sections, first permutation', async () => {
    // a 2 x 1 x 1 grid, two sections: rows i j k, Q x 2, (Re Im) x 2
    const rows = [
        '1 1 1  0 0 0  0 0 0  3 4  0 1',                 // (25 + 1) / 2 = 13
        '2 1 1  1 0 0  0 1 0  1 0  0 2',                 // (1 + 4) / 2 = 2.5
    ];
    const aver = await Converter.readOldDatStream(streamOf(rows.join('\n') + '\n'), { amplitudes: true });
    assert.deepEqual(Array.from(aver.values), [13, 2.5]);
    assert.match(aver.notes.join('\n'), /averaged over 2 symmetry sections/);
    const total = await Converter.readOldDatStream(streamOf(' ipermutation = 1\n' + rows.join('\n') +
        '\n ipermutation = 2\n1 1 1  0 0 0  0 0 0  9 9  9 9\n2 1 1  1 0 0  0 1 0  9 9  9 9\n'), { amplitudes: true });
    assert.deepEqual(Array.from(total.values), [13, 2.5]);
    assert.match(total.notes.join('\n'), /the first of 2 permutations/);
    await assert.rejects(Converter.readOldDatStream(streamOf('1 1 1 0 0 0 1\n'), { amplitudes: true }), /not i j k \+ 5 per/);
});

test('old-format .dat in hkl coordinates, and with symmetry sections', async () => {
    const m = sample(false);
    const cell = { lengths: [4, 4, 4], angles: [90, 90, 90] };
    const hklText = Array.from(Converter.writeOldDatChunks(m, cell, 0, { frame: 'hkl' })).join('');
    assert.equal(hklText.split('\n')[1].split(' ').slice(3, 6).map(Number).join(), '-1,0,0.5');
    const grid = await Converter.readOldDatStream(streamOf(hklText), { frame: 'hkl' });
    const back = Converter.toHklModel(grid, null);
    assert.deepEqual(back.corner, m.corner);
    assert.deepEqual(back.vectors.flat().map(x => +x.toFixed(12)), m.vectors.flat());
    assert.deepEqual(Array.from(back.values), Array.from(m.values));
    // m-3m sections: 48 coordinate triplets per row, the first the point itself
    const Processing = require('../js/processing.js');
    const ops = Processing.laueOperations('m-3m');
    ops.sort((a, b) => (a.flat().join() === '1,0,0,0,1,0,0,0,1' ? -1 : b.flat().join() === '1,0,0,0,1,0,0,0,1' ? 1 : 0));
    const secText = Array.from(Converter.writeOldDatChunks(m, cell, 0, { sections: ops })).join('');
    const lines = secText.split('\n');
    assert.equal(lines[0], '24 48');
    assert.equal(lines[1].split(' ').length, 3 + 3 * 48 + 1);
    const plain = Converter.toHklModel(await Converter.readOldDatStream(streamOf(secText), {}), cell);
    assert.ok(maxAbs(plain.corner, m.corner) < 1e-9);
    assert.deepEqual(Array.from(plain.values), Array.from(m.values));
});

const maxAbs = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

// ------------------------------------------- NumPy, VTK XML, CCP4/MRC, binary VTK

const cubic = { lengths: [4, 4, 4], angles: [90, 90, 90] };
const blobBytes = async blob => new Uint8Array(await blob.arrayBuffer());

test('crc32 gives the standard check value', () => {
    assert.equal(Converter.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('.npz: values, sigma, grid, cell and NaN survive a round trip; crop on read', async () => {
    const m = sample(true);
    m.values[5] = NaN;
    m.radiation = 'xray';
    const bytes = await blobBytes(Converter.writeNpz(m, cubic, {}));
    // a ZIP of .npy members, each header padded so the data start 64-byte aligned
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x50, 0x4b, 3, 4]);
    const npy = bytes.subarray(30 + (bytes[26] | (bytes[27] << 8)));
    assert.equal(String.fromCharCode(...npy.subarray(1, 6)), 'NUMPY');
    const hl = npy[8] | (npy[9] << 8);
    assert.equal((10 + hl) % 64, 0);
    assert.match(String.fromCharCode(...npy.subarray(10, 10 + hl)), /'descr': '<f8', 'fortran_order': False, 'shape': \(2, 3, 4\)/);
    const back = Converter.readNpz(bytes);
    assert.deepEqual(back.dims, m.dims);
    assert.deepEqual(back.corner, m.corner);
    assert.deepEqual(back.vectors, m.vectors);
    assert.deepEqual(back.cellLengths, cubic.lengths);
    assert.equal(back.radiation, 'xray');
    assert.equal(back.axesType, 'hkl');
    assert.ok(Number.isNaN(back.values[5]));
    for (let i = 0; i < 24; i++) if (i !== 5) assert.equal(back.values[i], m.values[i]);
    assert.deepEqual(Array.from(back.sigma), Array.from(m.sigma));
    // a Node Buffer (from a pool, where slice() shares memory) reads the same
    assert.deepEqual(Array.from(Converter.readNpz(Buffer.from(bytes)).sigma), Array.from(m.sigma));
    const single =Converter.readNpz(await blobBytes(Converter.writeNpz(m, cubic, { precision: 'float32' })));
    assert.ok(single.values instanceof Float32Array && single.sigma instanceof Float32Array);
    const cut = Converter.readNpz(bytes, { crop: { h: [-0.5, 0.5] } });
    assert.deepEqual(cut.dims, [3, 3, 2]);
    assert.deepEqual(cut.corner, [-0.5, 0, 0.5]);
    assert.equal(cut.values[0], m.values[1]);
    assert.equal(cut.sigma[3], m.sigma[5]);
    assert.match(cut.notes.join('\n'), /cropped on read to 3 x 3 x 2/);
    // a direct-space grid keeps its axes and content
    const uvw = Object.assign(sample(false), { axesType: 'uvw', content: '3d-delta-pdf' });
    const d = Converter.readNpz(await blobBytes(Converter.writeNpz(uvw, cubic)));
    assert.equal(d.axesType, 'uvw');
    assert.equal(d.content, '3d-delta-pdf');
});

// The attributes and decoded arrays of a .vti written by writeVtiChunks.
function parseVti(text) {
    const attr = name => new RegExp(`<ImageData[^>]*\\s${name}="([^"]*)"`).exec(text)[1].trim().split(/\s+/).map(Number);
    const arrays = {};
    for (const m of text.matchAll(/<DataArray type="(\w+)" Name="(\w+)" format="binary">([^<]*)<\/DataArray>/g)) {
        const raw = Buffer.from(m[3], 'base64');
        const size = Number(raw.readBigUInt64LE(0));
        assert.equal(raw.length, 8 + size);
        const body = new Uint8Array(raw.subarray(8));
        arrays[m[2]] = m[1] === 'Float32' ? new Float32Array(body.buffer) : new Float64Array(body.buffer);
    }
    return { extent: attr('WholeExtent'), origin: attr('Origin'), spacing: attr('Spacing'), direction: attr('Direction'), arrays };
}

test('.vti: the grid in Q with a Direction matrix, base64 arrays behind a UInt64 size', () => {
    const m = sample(true);
    m.values[5] = NaN;
    const v = parseVti(Array.from(Converter.writeVtiChunks(m, cubic)).join(''));
    const t = 2 * Math.PI / 4;
    assert.deepEqual(v.extent, [0, 3, 0, 2, 0, 1]);
    assert.ok(maxAbs(v.origin, [-t, 0, 0.5 * t]) < 1e-9);
    assert.ok(maxAbs(v.spacing, [0.5 * t, 0.25 * t, t]) < 1e-9);
    assert.deepEqual(v.direction, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.ok(Number.isNaN(v.arrays.values[5]));
    assert.equal(v.arrays.values[23], m.values[23]);
    assert.deepEqual(Array.from(v.arrays.sigma), Array.from(m.sigma));
    // a sheared grid: the second axis along [1 1 0]
    const s = sample(false);
    s.vectors = [[0.5, 0, 0], [0.25, 0.25, 0], [0, 0, 1]];
    const w = parseVti(Array.from(Converter.writeVtiChunks(s, cubic, { precision: 'float32' })).join(''));
    const r = Math.SQRT1_2;
    assert.ok(maxAbs(w.direction, [1, r, 0, 0, r, 0, 0, 0, 1]) < 1e-9);
    assert.ok(Math.abs(w.spacing[1] - 0.25 * Math.SQRT2 * t) < 1e-9);
    assert.ok(w.arrays.values instanceof Float32Array);
    // direct space in Angstrom; a single-point axis gets the normal of the others
    const d = Object.assign(sample(false), { axesType: 'uvw', dims: [4, 6, 1], vectors: [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 0]] });
    const x = parseVti(Array.from(Converter.writeVtiChunks(d, { lengths: [4, 5, 6], angles: [90, 90, 90] })).join(''));
    assert.ok(maxAbs(x.origin, [-4, 0, 3]) < 1e-9);
    assert.ok(maxAbs(x.spacing, [2, 1.25, 1]) < 1e-9);
    assert.deepEqual(x.direction, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepEqual(x.extent, [0, 3, 0, 5, 0, 0]);
});

test('CCP4/MRC: a direct-space map with the grid in its header', async () => {
    const d = Object.assign(sample(false), { axesType: 'uvw', corner: [-1, -0.25, -1] });
    d.values[5] = NaN;
    const u = await blobBytes(Converter.writeMrc(d, { lengths: [4, 5, 6], angles: [90, 90, 120] }));
    assert.equal(u.length, 1024 + 4 * 24);
    const dv = new DataView(u.buffer);
    const int = w => dv.getInt32(4 * w, true), flt = w => dv.getFloat32(4 * w, true);
    assert.deepEqual([0, 1, 2, 3].map(int), [4, 3, 2, 2]);              // NX NY NZ, mode 2 (float32)
    assert.deepEqual([4, 5, 6].map(int), [-2, -1, -1]);                 // NXSTART... = corner / step
    assert.deepEqual([7, 8, 9].map(int), [4, 3, 2]);                    // MX MY MZ
    assert.ok(maxAbs([10, 11, 12].map(flt), [8, 3.75, 12]) < 1e-5);    // the cell spans N steps
    assert.deepEqual([13, 14, 15].map(flt), [90, 90, 120]);
    assert.deepEqual([16, 17, 18].map(int), [1, 2, 3]);
    assert.equal(flt(20), 321);
    assert.equal(int(27), 20140);
    assert.equal(String.fromCharCode(...u.subarray(208, 212)), 'MAP ');
    assert.deepEqual(Array.from(u.subarray(212, 214)), [0x44, 0x44]);
    const data = new Float32Array(u.slice(1024).buffer);
    assert.equal(data[5], 0);                                           // NaN written as 0
    assert.equal(data[23], d.values[23]);
    assert.throws(() => Converter.writeMrc(sample(false), cubic), /reciprocal space|direct-space/);
    assert.throws(() => Converter.checkWritable(sample(false), 'mrc'), /reciprocal space/);
    const skew = Object.assign(sample(false), { axesType: 'uvw', vectors: [[0.5, 0, 0], [0.25, 0.25, 0], [0, 0, 1]] });
    assert.throws(() => Converter.writeMrc(skew, cubic), /along u, v and w/);
    const off = Object.assign(sample(false), { axesType: 'uvw', corner: [-0.9, 0, 0] });
    assert.throws(() => Converter.writeMrc(off, cubic), /whole number of steps/);
});

test('legacy VTK in binary: big-endian float32 after the header, and read back', async () => {
    const m = sample(false);
    m.values[5] = NaN;
    const u = await blobBytes(new Blob(Array.from(Converter.writeVtkChunks(m, cubic, 0, { binary: true }))));
    const head = String.fromCharCode(...u.subarray(0, 300));
    assert.match(head, /\nBINARY\nDATASET STRUCTURED_POINTS\nDIMENSIONS 4 3 2\n/);
    assert.ok(Converter.isBinaryVtk(head));
    assert.equal(Converter.isBinaryVtk(Array.from(Converter.writeVtkChunks(m, cubic)).join('')), false);
    const grid = Converter.readVtkBinary(u);
    assert.deepEqual(grid.dims, [4, 3, 2]);
    assert.equal(grid.values[5], 0);
    assert.equal(grid.values[23], m.values[23]);
    const back = Converter.toHklModel(grid, cubic);
    assert.ok(maxAbs(back.corner, m.corner) < 1e-8);
    const ascii = Converter.parseVtk(Array.from(Converter.writeVtkChunks(m, cubic)).join(''), cubic);
    assert.deepEqual(Array.from(back.values), Array.from(ascii.values));
    assert.throws(() => Converter.readVtkBinary(u.subarray(0, u.length - 9)), /truncated/);
});

// ------------------------------------------------------ 3DSCalculator exports

// 3DSCalculator's cellGeometry: cell2vec (c along z, rows = lattice
// vectors), Bq = 2 pi transpose(inverse(direct)), and Q = [h, k, l] * Bq.
function calculatorBq(a, b, c, al, be, ga) {
    const r = x => x * Math.PI / 180;
    [al, be, ga] = [al, be, ga].map(r);
    const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    v[2][0] = a * Math.cos(be);
    v[1][1] = b * Math.sin(al);
    v[2][1] = b * Math.cos(al);
    v[2][2] = c;
    v[1][0] = (a * b * Math.cos(ga) - v[2][0] * v[2][1]) / v[1][1];
    v[0][0] = Math.sqrt(Math.max(0, a * a - v[1][0] * v[1][0] - v[2][0] * v[2][0]));
    const direct = [[v[0][0], v[1][0], v[2][0]], [v[0][1], v[1][1], v[2][1]], [v[0][2], v[1][2], v[2][2]]];
    const [[p, q, s], [t, u, w], [x, y, z]] = direct;
    const det = p * (u * z - w * y) - q * (t * z - w * x) + s * (t * y - u * x);
    const inv = [[u * z - w * y, s * y - q * z, q * w - s * u], [w * x - t * z, p * z - s * x, s * t - p * w], [t * y - u * x, q * x - p * y, p * u - q * t]]
        .map(row => row.map(e => e / det));
    return [0, 1, 2].map(i => [0, 1, 2].map(j => 2 * Math.PI * inv[j][i]));
}

test('3DSCalculator .json: grid, l-fastest intensities, NaN as null, and the cell from Bq', () => {
    const shape = [3, 2, 4], hAxis = [-1, -0.5, 0], kAxis = [0, 0.25], lAxis = [0, 0.5, 1, 1.5];
    const intensity = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let m = 0; m < 4; m++) intensity.push(100 * i + 10 * j + m);
    intensity[5] = null;                                                     // (0, 1, 1), JSON's NaN
    const Bq = calculatorBq(4, 4, 6, 90, 90, 120);
    const text = JSON.stringify({
        sourceFile: 'x.rmc6f', atoms: 10, supercell: [5, 5, 3], cellDeg: [20, 20, 18, 90, 90, 120], shape, hAxis, kAxis, lAxis,
        Bq, Bp: null, hklToQ: 'Q = [h,k,l] * Bq', minI: 0, maxI: 213, backend: 'cpu', options: {}, intensity,
    });
    assert.ok(Converter.is3dsCalculatorJson(text.slice(0, 4096)));
    assert.equal(Converter.is3dsCalculatorJson('{"version":1,"steps":[]}'), false);
    const m = Converter.read3dsCalculatorJson(text);
    assert.deepEqual(m.dims, shape);
    assert.deepEqual(m.corner, [-1, 0, 0]);
    assert.deepEqual(m.vectors, [[0.5, 0, 0], [0, 0.25, 0], [0, 0, 0.5]]);
    assert.ok(maxAbs(m.cellLengths, [4, 4, 6]) < 1e-9 && maxAbs(m.cellAngles, [90, 90, 120]) < 1e-9);
    assert.ok(!/differs/.test(m.notes.join('\n')));
    const at = (i, j, l) => m.values[(l * 2 + j) * 3 + i];                  // h fastest inside
    assert.equal(at(2, 1, 3), 213);
    assert.equal(at(1, 0, 2), 102);
    assert.ok(Number.isNaN(at(0, 1, 1)));
    // Q from the recovered cell (a along x) has the same length as 3DSCalculator's (c along z)
    const B = Converter.reciprocalBasis(Converter.cellToLattice(m.cellLengths, m.cellAngles));
    const hkl = [0.5, 0.25, 1.5];
    const ours = Converter.hklToQ(B, hkl);
    const theirs = [0, 1, 2].map(j => hkl[0] * Bq[0][j] + hkl[1] * Bq[1][j] + hkl[2] * Bq[2][j]);
    assert.ok(Math.abs(Math.hypot(...ours) - Math.hypot(...theirs)) < 1e-12);
    const cut = Converter.read3dsCalculatorJson(text, { crop: { l: [0.5, 1] } });
    assert.deepEqual(cut.dims, [3, 2, 2]);
    assert.equal(cut.values[0], 1);
    assert.throws(() => Converter.read3dsCalculatorJson(JSON.stringify({ shape: [2, 1, 1], hAxis: [0, 1], kAxis: [0], lAxis: [0], intensity: [1] })),
        /1 intensities for a 2 x 1 x 1 grid/);
});

test('3DSCalculator .dat: "# h k l intensity" rows read as an hkl list', () => {
    const rows = ['# h k l intensity'];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let m = 0; m < 2; m++) rows.push(`${-1 + 0.5 * i} ${0.25 * j} ${m} ${i === 1 && j === 1 && m === 0 ? 'NaN' : 100 * i + 10 * j + m}`);
    const text = rows.join('\n');
    assert.ok(Converter.is3dsCalculatorDat(text) && Converter.isHklList(text));
    assert.equal(Converter.is3dsCalculatorDat('1 2 3 4\n'), false);
    assert.ok(Converter.isHklList('1 2 3 NaN\n1 2 4 5\n'));
    const m = Converter.hklListModel(Converter.parseHklList(text));
    assert.deepEqual(m.dims, [3, 2, 2]);
    assert.deepEqual(m.corner, [-1, 0, 0]);
    assert.equal(m.values[(1 * 2 + 1) * 3 + 2], 211);
    assert.ok(Number.isNaN(m.values[(0 * 2 + 1) * 3 + 1]));
});
