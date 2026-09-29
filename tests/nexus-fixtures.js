'use strict';
/*
 * HDF5 test files built with h5wasm: a Mantid SaveMD (version 2)
 * MDHistoWorkspace, an NXrefine-like NXdata entry and an rspace3d volume.
 * Shared by the Node tests and the browser test.
 */
const { buildH5, Converter } = require('./helpers');

// Encodes the index: value(i0, i1, i2) = 100 i2 + 10 i1 + i0 (i0 fastest).
const code = (i0, i1, i2) => 100 * i2 + 10 * i1 + i0;
function fastestFirst(n0, n1, n2, Arr) {
    const v = new (Arr || Float64Array)(n0 * n1 * n2);
    for (let i2 = 0; i2 < n2; i2++)
        for (let i1 = 0; i1 < n1; i1++)
            for (let i0 = 0; i0 < n0; i0++) v[(i2 * n1 + i1) * n0 + i0] = code(i0, i1, i2);
    return v;
}
const at = (m, ih, ik, il) => m.values[(il * m.dims[1] + ik) * m.dims[0] + ih];
const linspace = (a, b, n) => Float64Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

// A SaveMD version 2 MDHistoWorkspace as Mantid writes it.
function mantidFile(o) {
    o = Object.assign({ n: [4, 3, 2], names: ['[H,0,0]', '[0,K,0]', '[0,0,L]'], frame: 'HKL', system: 3,
        W: [1, 0, 0, 0, 1, 0, 0, 0, 1], edges: [[-1, 1], [-3, 3], [0, 2]] }, o);
    return buildH5(f => {
        const ws = f.create_group('MDHistoWorkspace');
        ws.create_attribute('NX_class', 'NXentry');
        ws.create_attribute('SaveMDVersion', 2, [], '<i');
        ws.create_attribute('QConvention', 'Inelastic');
        ws.create_dataset({ name: 'coordinate_system', data: new Uint32Array([o.system]), shape: [1], dtype: '<I' });
        const d = ws.create_group('data');
        d.create_attribute('NX_class', 'NXdata');
        const nd = o.n.length;
        o.n.forEach((n, j) => {
            const e = linspace(o.edges[j][0], o.edges[j][1], n + 1);
            const ds = d.create_dataset({ name: 'D' + j, data: e, shape: [n + 1], dtype: '<d' });
            ds.create_attribute('frame', o.frame);
            ds.create_attribute('long_name', o.names[j]);
            ds.create_attribute('units', o.frame === 'HKL' ? 'r.l.u.' : 'Angstrom^-1');
        });
        const shape = o.n.slice().reverse();
        const values = o.values || fastestFirst(o.n[0], o.n[1] || 1, o.n[2] || 1);
        const sig = d.create_dataset({ name: 'signal', data: values, shape, dtype: '<d' });
        sig.create_attribute('signal', 1, [], '<i');
        sig.create_attribute('axes', Array.from({ length: nd }, (_, i) => 'D' + (nd - 1 - i)).join(':'));
        d.create_dataset({ name: 'mask', data: o.mask || new Int8Array(values.length), shape, dtype: '<b' });
        // variance = 4 * signal, so sigma = 2 sqrt(signal)
        d.create_dataset({ name: 'errors_squared', data: Float64Array.from(values, v => 4 * Math.abs(v)), shape, dtype: '<d' });
        const ol = ws.create_group('experiment0').create_group('sample').create_group('oriented_lattice');
        [['a', 4.05], ['b', 4.05], ['c', 4.05], ['alpha', 90], ['beta', 90], ['gamma', 90]].forEach(([k, v]) =>
            ol.create_dataset({ name: 'unit_cell_' + k, data: [v], shape: [1], dtype: '<d' }));
        if (o.W) {
            const w = f.get('MDHistoWorkspace/experiment0').create_group('logs').create_group('W_MATRIX');
            w.create_dataset({ name: 'value', data: o.W, shape: [9], dtype: '<d' });
        }
        if (o.extra) o.extra(f);
    });
}

// NXrefine-like: entry/transform with axes [Ql, Qk, Qh] (points), float32
// data, weights, and the cell in entry/sample.
function nxrefineFile(opts) {
    opts = opts || {};
    const [nh, nk, nl] = [5, 4, 3];
    return buildH5(f => {
        f.create_attribute('default', 'entry');
        const e = f.create_group('entry');
        e.create_attribute('NX_class', 'NXentry');
        e.create_attribute('default', 'transform');
        const s = e.create_group('sample');
        s.create_attribute('NX_class', 'NXsample');
        [['a', 3.9], ['b', 3.9], ['c', 12.7], ['alpha', 90], ['beta', 90], ['gamma', 90]].forEach(([k, v]) =>
            s.create_dataset({ name: 'unitcell_' + k, data: [v], shape: [1], dtype: '<d' }));
        s.create_dataset({ name: 'laue_group', data: ['4/mmm'], shape: [1], dtype: 'S5' });
        s.create_dataset({ name: 'temperature', data: [300], shape: [1], dtype: '<d' });
        const mono = e.create_group('instrument').create_group('monochromator');
        mono.create_dataset({ name: 'wavelength', data: [0.1665], shape: [1], dtype: '<d' });
        const t = e.create_group('transform');
        t.create_attribute('NX_class', 'NXdata');
        t.create_attribute('signal', 'data');
        t.create_attribute('axes', ['Ql', 'Qk', 'Qh'], [3], 'S2');
        [['Qh', linspace(-1, 1, nh)], ['Qk', linspace(-1.5, 1.5, nk)], ['Ql', linspace(0, 1, nl)]].forEach(([name, v]) => {
            const ds = t.create_dataset({ name, data: v, shape: [v.length], dtype: '<d' });
            ds.create_attribute('long_name', name[1].toUpperCase() + ' (r.l.u.)');
        });
        if (opts.link) {
            t.create_external_link(opts.link, '/entry/data/v', 'data');
        } else {
            t.create_dataset({ name: 'data', data: fastestFirst(nh, nk, nl, Float32Array), shape: [nl, nk, nh], dtype: '<f' });
            t.create_dataset({ name: 'weights', data: new Float32Array(nh * nk * nl).fill(2), shape: [nl, nk, nh], dtype: '<f' });
        }
        if (opts.extra) opts.extra(f);
    });
}

// An rspace3d file as its volume builder writes one: data C [nh, nk, nl],
// 1-D H/K/L, cell_* and wavelength attributes, UB (1/wavelength units) and
// M_inv for an HK raster. o: { cell, noCell, noMinv, extra(f) }.
async function rspace3dFile(o) {
    o = Object.assign({ cell: [5, 6, 7, 80, 95, 100], wavelength: 0.7 }, o);
    const H = [-1, -0.5, 0, 0.5], K = [-0.4, -0.2, 0], L = [1, 1.25];
    const values = new Float32Array(24);
    for (let ih = 0, n = 0; ih < 4; ih++) for (let ik = 0; ik < 3; ik++) for (let il = 0; il < 2; il++, n++) values[n] = 100 * ih + 10 * ik + il;
    values[5] = NaN;                                                       // (0, 2, 1) unmeasured
    const B = Converter.reciprocalBasis(Converter.cellToLattice(o.cell.slice(0, 3), o.cell.slice(3)));
    const g = (i, j) => B[0][i] * B[0][j] + B[1][i] * B[1][j] + B[2][i] * B[2][j];
    const shear = -g(0, 1) / g(0, 0);
    return buildH5(f => {
        f.create_dataset({ name: 'data', data: values, shape: [4, 3, 2], dtype: '<f' });
        [['H', H], ['K', K], ['L', L]].forEach(([n, a]) => f.create_dataset({ name: n, data: a, shape: [a.length], dtype: '<d' }));
        if (!o.noCell) {
            ['cell_a', 'cell_b', 'cell_c', 'cell_alpha', 'cell_beta', 'cell_gamma'].forEach((n, i) => f.create_attribute(n, o.cell[i], [], '<d'));
        }
        f.create_attribute('wavelength', o.wavelength, [], '<d');
        f.create_attribute('plane_type', 'HK');
        f.create_attribute('laue_group', '-1');
        f.create_attribute('symmetry_ops_applied', 2, [], '<i');
        // a rotated UB: U * B * wavelength
        const c = Math.cos(0.3), s = Math.sin(0.3), U = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
        const UB = [0, 1, 2].map(r => [0, 1, 2].map(k => o.wavelength * (U[r][0] * B[0][k] + U[r][1] * B[1][k] + U[r][2] * B[2][k])));
        f.create_dataset({ name: 'UB', data: UB.flat(), shape: [3, 3], dtype: '<d' });
        if (!o.noMinv) f.create_dataset({ name: 'M_inv', data: [3, 3 * shear, 0, 3], shape: [2, 2], dtype: '<d' });
    }).then(file => ({ file, shear, H, K, L }));
}

// subhkl's indexer output: the cell as scalars under sample/, U, B and the peaks.
function subhklFile() {
    return buildH5(f => {
        const s = f.create_group('sample');
        [['a', 8.1], ['b', 8.1], ['c', 8.1], ['alpha', 90], ['beta', 90], ['gamma', 90]].forEach(([n, v]) => s.create_dataset({ name: n, data: v }));
        s.create_dataset({ name: 'space_group', data: 'F d -3 m' });
        s.create_dataset({ name: 'B', data: [1 / 8.1, 0, 0, 0, 1 / 8.1, 0, 0, 0, 1 / 8.1], shape: [3, 3], dtype: '<d' });
        s.create_dataset({ name: 'U', data: [1, 0, 0, 0, 1, 0, 0, 0, 1], shape: [3, 3], dtype: '<d' });
        const p = f.create_group('peaks');
        for (const n of ['h', 'k', 'l']) p.create_dataset({ name: n, data: [1, 1, 1, 2], shape: [4], dtype: '<d' });
    });
}

module.exports = { code, fastestFirst, at, linspace, mantidFile, nxrefineFile, rspace3dFile, subhklFile };
