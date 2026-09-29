'use strict';
/*
 * Test helpers: load the vendored h5wasm bundle and the converter in Node,
 * and build small HDF5 files in h5wasm's in-memory file system.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const Converter = require(path.join(ROOT, 'js', 'converter.js'));

let h5Ready = null;
let seq = 0;

// js/h5wasm.js is a browser IIFE that declares a global `h5wasm`; wrapping
// the source in a function evaluates it in Node without a bundler.
function loadH5wasm() {
    if (!h5Ready) {
        const src = fs.readFileSync(path.join(ROOT, 'js', 'h5wasm.js'), 'utf8');
        const h5wasm = new Function('require', src + '\nreturn h5wasm;')(require);
        h5Ready = h5wasm.ready.then(() => {
            h5wasm.Module.activate_throwing_error_handler();   // as index.html does
            return h5wasm;
        });
    }
    return h5Ready;
}

// Create a file with build(file), close it, and reopen it read-only.
async function buildH5(build) {
    const h5wasm = await loadH5wasm();
    const name = `test_${seq++}.h5`;
    const file = new h5wasm.File(name, 'w');
    try {
        build(file);
    } finally {
        file.close();
    }
    return new h5wasm.File(name, 'r');
}

async function openH5Bytes(bytes) {
    const h5wasm = await loadH5wasm();
    const name = `test_${seq++}.h5`;
    h5wasm.FS.writeFile(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return new h5wasm.File(name, 'r');
}

function openH5(relPath) {
    return openH5Bytes(fs.readFileSync(path.join(ROOT, relPath)));
}

function readText(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function maxAbsDiff(a, b) {
    if (a.length !== b.length) return Infinity;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
}

// Minimal legacy VTK STRUCTURED_POINTS text.
function vtkText(title, dims, origin, spacing, values) {
    return [
        '# vtk DataFile Version 2.0', title, 'ASCII', 'DATASET STRUCTURED_POINTS',
        `DIMENSIONS ${dims.join(' ')}`, `ORIGIN ${origin.join(' ')}`, `SPACING ${spacing.join(' ')}`,
        `POINT_DATA ${values.length}`, 'SCALARS intensity float', 'LOOKUP_TABLE default',
        ...Array.from(values, String),
    ].join('\n') + '\n';
}

module.exports = {
    ROOT, Converter, loadH5wasm, buildH5, openH5, openH5Bytes, readText, maxAbsDiff, vtkText,
};
