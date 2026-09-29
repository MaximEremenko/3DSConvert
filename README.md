# 3DSConvert

**Live tool:** https://maximeremenko.github.io/3DSConvert/

A browser-based converter for 3-D single-crystal diffuse-scattering data.
It translates the same intensity grid between the file formats used by
RMCProfile, DISCUS, Yell, Meerkat, and Scatty — entirely client-side.
No installation, no server, and no upload: files never leave your computer.

## Supported formats

| Format | Read | Write | Typical producer |
| --- | --- | --- | --- |
| Unified data format (HDF5) | yes | yes | RMCProfile, DiffuseCode/DISCUS |
| Yell 1.0 (HDF5) | yes | yes | DISCUS, Yell, Meerkat |
| RMCProfile old text format (`.dat`) | yes | yes | RMCProfile Diffuse3D |
| VTK `STRUCTURED_POINTS` (`.vtk`) | yes | yes | Scatty, Spinteract, 3DSCalculator; also loads in ParaView |

Any format can be converted to any other. The input format is detected
automatically from the file content.

### Format notes

- **Unified data format**: both the `/scattering/data` compatibility layout
  and the RMCProfile/DISCUS `/entry/data` layout are read; written files
  contain both. New output follows the current common contract: the mandatory
  crystal-metadata audit datasets are written under `/entry/data`, with
  `audit_conform_dict_name = Disorder unified data`,
  `data_type_axes = hkl`, and `data_type_number = real`. Readers accept
  the older `Disorder scattering` name and infer missing axes metadata as
  RMCProfile does for legacy files, but reject a structure dictionary or an
  unsupported axes/number type instead of silently treating it as HKL data.
  Three-dimensional `Q` axes are converted to HKL using the real parent
  cell; scalar or direct-space axis types are outside this diffuse converter.
  Dataset shapes are checked against `data_dimension` and the `h`/`k`/`l`
  coordinate arrays. Files in the transposed `/scattering/data` layout of the
  `write_diffuse_scattering.py` reference writer (C order `[nh,nk,nl]`, one
  `step_vectors` column per axis) are read when the shape or the NeXus
  `h_indices`/`k_indices`/`l_indices` attributes tell the order apart. This
  includes legacy "Disorder scattering 1.0" files (`.nx5`) that keep the grid
  only in the `h`/`k`/`l` arrays and the cell in `unit_cell`. When `h` and `l`
  have equal lengths the shape cannot tell the layouts apart, so this
  converter's layout is assumed, with a log note for files that do not look
  like RMCProfile or 3DSConvert output.
- **Yell 1.0**: the flat layout with `/data`, `/lower_limits`, `/step_sizes`,
  and `/unit_cell` datasets (the general step vectors
  `step_sizes_abs/ord/top` are used when present). Files that store the unit
  metric (`unit_cell = 1 1 1 90 90 90`) are interpreted as hkl grids in
  reciprocal lattice units of the parent cell; written files always store the
  real cell when one is known. 1-D and 2-D `data` are read as grids with one
  point along the missing axes, and `step_size` is accepted in place of
  `step_sizes`. Direct-space files (`is_direct = 1`, e.g. 3D-ΔPDF maps) are
  refused. An `is_direct` value that is neither 0 nor 1 is reported as a
  corrupted flag; set *Yell data space* to *reciprocal space* to read such a
  file anyway.
- **RMCProfile old text format**: an `npoints nsec` header followed by
  `i j k qx qy qz intensity` rows. Q is cartesian in 1/Angstrom with the
  2*pi convention, `q = 2*pi * B * hkl`, where `B` is the reciprocal basis
  of the parent cell. Files with several symmetry sections are read using
  the section 1 coordinates. RMCProfile's `*_calc.dat` output adds
  `scale offset` to the header; they are logged and the intensities are
  kept as stored. Fortran `D` exponents are accepted, and a row may wrap
  over several lines. Grid points missing from a file are read as NaN; when
  pixel (1,1,1) or its neighbours are among them, the grid geometry is
  fitted to all rows. On output, NaN or infinite intensities are written as
  0.0, which RMCProfile treats as a masked point (points with I = 0 are left
  out of the fit).
- **VTK**: ASCII `STRUCTURED_POINTS`. In Scatty (`*_sc.vtk`) and Spinteract
  (`*_img_NN.vtk`) output, `ORIGIN` and `SPACING` are cartesian Q in
  1/Angstrom (2*pi convention, the same as the old text format); values run
  x fastest, z slowest. The format stores no axis directions: Scatty and
  Spinteract write `ORIGIN` as the cartesian corner but `SPACING` only as
  step lengths along their grid axes, which may be any mutually orthogonal
  hkl directions (e.g. `X_AXIS 6 6 0`). Without more information the axes
  are assumed to lie along cartesian x, y and z. For rotated grids, load the
  program's config file as the *grid config*: it gives the exact hkl corner
  and steps (Scatty: `CENTRE` and half-extent axes with 2p+1 points;
  Spinteract: `ORIGIN` and full-extent axes with n points, one grid per data
  set), and the VTK header is cross-checked against it at the chosen cell.
  3DSCalculator's "(HKL grid)" export and Scatty's `*_sc_supercell.vtk`
  store `ORIGIN`/`SPACING` in reciprocal-lattice units; they are recognised
  by their title line and need no cell to read. Writing VTK requires the Q
  grid to be axis-aligned and ascending, because `STRUCTURED_POINTS` cannot
  express other grids; NaN or infinite values are written as 0, since legacy
  VTK readers do not parse NaN.
- **HDF5 compression**: the browser HDF5 engine decodes gzip/deflate,
  shuffle, szip, fletcher32, n-bit and scale-offset. Datasets compressed
  with plugin filters (LZF, Blosc, LZ4, bitshuffle, Zstandard, ...) are
  refused with a message that names the filter; re-save such files with
  gzip, e.g. `h5repack -f GZIP=4 in.h5 out.h5`.

## Getting started

Open `index.html` in any modern browser — double-clicking the
file works, no web server is required. The app is fully self-contained:
the HDF5 engine ([h5wasm](https://github.com/usnistgov/h5wasm), WebAssembly)
is vendored in `js/h5wasm.js` with the `.wasm` binary embedded directly in
the script, so nothing is fetched at runtime and the page works from a
`file://` URL as well as from any static host. The reading and conversion
run in a Web Worker that the page builds from the loaded scripts, so the
page stays responsive and this also works from `file://`. If you prefer
serving it locally:

```
python -m http.server
```

then browse to `http://localhost:8000/`.

## Usage

1. **Data file**: select the diffuse data file (`.h5`, `.nx5`, `.dat`, or
   `.vtk`). The format, grid size, and stored cell are reported in the log.
   For a Scatty or Spinteract VTK whose grid axes are not along a*, b*, c*,
   also load the program's config file as the grid config.
2. **Unit cell**: some conversions need the parent (crystallographic) unit
   cell, because the text and VTK formats do not store one, and some Yell
   files store only the unit metric. Provide either
   - a structure file: `.rmc6f` or unified structure `.h5`. For `.rmc6f`,
     the parent cell is the supercell divided by its dimensions. In the
     unified structure contract, `unit_cell_lengths` already stores the
     basic/parent cell and is used directly; or
   - the parent cell typed in directly (a, b, c in Angstrom; alpha, beta,
     gamma in degrees).
   When the data file already stores a real cell (for example RMCProfile
   `_calc.h5` output), it is used automatically and this section can be left
   empty.
3. **Output**: pick the target format, optionally set the radiation metadata
   for HDF5 output, and press "Convert & download". For HDF5 output you can
   also choose
   - the precision of the data array: the same as the input (float32 data
     stay float32), float64, or float32;
   - the unified layout: both `/scattering/data` and `/entry/data` (the
     default), or `/entry/data` only, which halves the file;
   - gzip compression, which is slower to write.

   Text output (`.dat`, `.vtk`) is streamed directly to disk in browsers
   that support the File System Access API (Chromium); elsewhere a chunked
   in-memory download is used. The log reports the expected output size
   first, and reading and writing show progress and can be cancelled.

### Large files

Data files are read without first loading them into memory: HDF5 files
are mounted in the worker and read slab by slab, and text files are parsed
as a stream (an 860 MB, 10-million-row `.dat` reads in about 5 s). Text
files are parsed once when loaded; changing the cell afterwards needs no
re-read. The limits are the browser's: the volume itself must fit in
memory, and an HDF5 output file is assembled in memory, which Chrome and
Edge cap at about 2 GB; float32, the `/entry/data`-only layout or
compression reduce it. Text output streamed to disk has no such limit.

### When is the unit cell required?

| Input | Cell needed? |
| --- | --- |
| Unified `.h5` with a real cell | no |
| Yell `.h5` with a real cell | no |
| Yell `.h5` with unit metric | yes (for `.dat`/`.vtk` output; passed through for HDF5 output) |
| Old text `.dat` | yes, always |
| Q-space `.vtk` (Scatty, Spinteract) | yes, always |
| r.l.u. `.vtk` (3DSCalculator, Scatty supercell) | yes (for `.dat`/`.vtk` output; passed through for HDF5 output) |

## Examples

The `Examples/` folder contains one small synthetic dataset (cubic parent
cell a = 5.63 Angstrom, 5 x 5 x 5 grid, hkl from -1 to 1 in steps of 0.5)
written in every supported format, plus a matching structure file:

| File | Demonstrates |
| --- | --- |
| `example_unified.h5` | Unified data format (both `/entry/data` and `/scattering/data` layouts) |
| `example_yell.h5` | Yell 1.0 HDF5 |
| `example_diffuse3d.dat` | RMCProfile old text format |
| `example_scatty.vtk` | Scatty VTK (`STRUCTURED_POINTS`) |
| `example_structure.rmc6f` | Parent-cell input: NaCl structure with a 2 x 2 x 2 supercell |

Load any of the data files, add `example_structure.rmc6f` where a cell is
required, and convert in any direction; the intensity values are identical
in all files, so results are easy to compare.

## Repository layout

- `index.html` — the browser app (UI); it starts the conversion worker.
- `js/worker.js` — the conversion worker: file mounting, loading, conversion
  planning and output, driven by messages from the page.
- `js/converter.js` — format readers/writers and the cell/reciprocal-space
  math. Plain JavaScript with a UMD wrapper, also loadable from Node.js for
  testing.
- `js/unified_hdf5.js` — shared helpers for the unified HDF5
  structure/data contract. Not loaded by the converter page itself; this is
  the canonical copy of a library shared with the companion browser tools
  (see Provenance).
- `js/h5wasm.js` — vendored h5wasm bundle (see Third-party code).
- `Examples/` — the example dataset described above.
- `tests/` — Node.js regression tests and a browser test (see Validation).

## Validation

The conversion core was verified against real files from each producer:

- Yell/DISCUS: a DISCUS-written Yell 1.0 file converts to the RMCProfile old
  text format reproducing an independently produced reference `.dat` for the
  same dataset at the reference file's own precision.
- Scatty: parsing a Scatty `.vtk` reproduces the intensities of Scatty's
  paired `*_list.txt` hkl output exactly, and the recovered hkl grid matches
  it to the 6-decimal precision of the VTK header.
- RMCProfile: HDF5 files written by the converter follow the same dataset
  layouts, mandatory audit/type metadata, axis ordering, and fixed-length
  string types as RMCProfile's Fortran implementation
  (`unified_config/unified_hdf5_io.f90`), and round-trip conversions through
  every format are exact at double precision.

RMCProfile (built with `RMC_ENABLE_HDF5=ON`) provides Fortran command-line
equivalents for the unified/old-text conversions: `unified_to_diffuse3d`
and `diffuse3d_to_unified`.

The regression tests run the converter and the vendored HDF5 engine under
Node.js 22 or later, with nothing to install:

```
npm test
```

They round-trip the examples through every format and cover the reader
edge cases described under Format notes. A browser test drives
`index.html` from `file://` in headless Chrome or Edge through the
DevTools protocol, feeding files into the page and checking the downloads
(set `CHROME` to the browser executable if it is not found):

```
npm run test:e2e
```

GitHub Actions runs both on every push.

## Third-party code

`js/h5wasm.js` is a vendored copy of
[h5wasm](https://github.com/usnistgov/h5wasm) 0.10.3 (the HDF5 library
compiled to WebAssembly; this bundle embeds libhdf5 2.0.0). It is
distributed under the NIST and HDF5 license terms reproduced in
[`js/h5wasm-LICENSE.txt`](js/h5wasm-LICENSE.txt). The only change is a
wrapper: the bundle's code sits inside a function, `h5wasmModule()`, whose
source text the page uses to start the HDF5 engine in its Web Worker.

## Provenance

This repository was extracted, with full git history, from the
[MaximEremenko/Utilities](https://github.com/MaximEremenko/Utilities)
monorepo, where the tool lived at `RMCProfileUtilities/Format_Converter`.
`js/unified_hdf5.js` originates in this project and is also vendored into
the companion `3DSCalculator` and `3DSView`
repositories.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Third-party components keep
their own licenses as noted above.
