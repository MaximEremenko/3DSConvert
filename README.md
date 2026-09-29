# 3DSConvert

**Live tool:** https://maximeremenko.github.io/3DSConvert/

A browser-based converter for 3-D single-crystal diffuse-scattering data.
It translates the same intensity grid between the file formats used by
RMCProfile, DISCUS, Yell, Meerkat, and Scatty, and reads reduced NeXus
volumes from Mantid and NXrefine — entirely client-side. On the way it can
process the data (crop, rebin, mask, subtract backgrounds, symmetrize) and
compute the 3D-ΔPDF, and it records the steps in the output.
No installation, no server, and no upload: files never leave your computer.

## Supported formats

| Format | Read | Write | Typical producer |
| --- | --- | --- | --- |
| Unified data format (HDF5) | yes | yes | RMCProfile, DiffuseCode/DISCUS |
| Yell 1.0 (HDF5) | yes | yes | DISCUS, Yell, Meerkat |
| RMCProfile old text format (`.dat`) | yes | yes | RMCProfile Diffuse3D |
| VTK `STRUCTURED_POINTS` (`.vtk`) | yes | yes | Scatty, Spinteract, 3DSCalculator; also loads in ParaView |
| NeXus: Mantid MDHistoWorkspace (`.nxs`) | yes | no | Mantid `SaveMD` (CORELLI, TOPAZ, WAND², DEMAND, SXD, ...) |
| NeXus: NXdata (`.nxs`) | yes | no | NXrefine (APS 6-ID-D, CHESS QM2), other NeXus writers |
| \|Q\| profile (`.txt`) | no | yes | shell averages of the (processed) volume |

Any readable format can be converted to any writable one. The input format
is detected automatically from the file content. The unified and Yell
formats also hold direct-space 3D-ΔPDF maps (u, v, w axes); these are read
and written in those two formats only.

### Format notes

- **Unified data format**: both the `/scattering/data` compatibility layout
  and the RMCProfile/DISCUS `/entry/data` layout are read; written files
  contain both. New output follows the current common contract: the mandatory
  crystal-metadata audit datasets are written under `/entry/data`, with
  `audit_conform_dict_name = Disorder unified data`,
  `data_type_axes = hkl` (`uvw` for a 3D-ΔPDF), and `data_type_number = real`. Readers accept
  the older `Disorder scattering` name and infer missing axes metadata as
  RMCProfile does for legacy files, but reject a structure dictionary or an
  unsupported axes/number type instead of silently treating it as HKL data.
  Three-dimensional `Q` axes are converted to HKL using the real parent
  cell. Direct-space 3D-ΔPDF data are read and written with the labels
  DiffuseCode uses (`data_type_axes = uvw`, `data_type_reciprocal =
  patterson`, `data_type_style = single_pdf`, `data_type_content =
  3d-delta-pdf`, axes `u`/`v`/`w`); scalar axis types (`2theta`, `r`, ...)
  are refused. `data_type_symmetrized` is passed on, and processed output
  records its recipe in `/entry/process` (see Processing).
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
  `step_sizes`. Direct-space files (`is_direct = 1`, Yell's 3D-ΔPDF maps)
  are read as u, v, w grids and written back with `is_direct = 1`. An
  `is_direct` value that is neither 0 nor 1 is reported as a
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
- **Mantid MDHistoWorkspace** (`SaveMD` version 2): `data/signal` is read
  with dimension `D0` as the grid abscissa. `D0`–`D2` hold bin edges, so the
  grid points are the bin centres. Only workspaces in the HKL frame are
  read; each dimension may be a projection, taken from the columns of
  `experiment0/logs/W_MATRIX` (cross-checked against names like `[H,H,0]`),
  which gives a sheared hkl grid. Masked bins and the infinite values left by
  normalising with zero become NaN, as do bins without events; the log
  reports how many. The cell comes from
  `experiment0/sample/oriented_lattice`, and the radiation is set to
  neutron. Q-frame and 4-D workspaces, MDEventWorkspaces, event
  workspaces and raw instrument files are refused with an explanation.
- **NeXus NXdata**: the group named by the `@default` attributes is read,
  or another one chosen from the list that appears when a file holds
  several. Signals and axes are found from the current (`@signal`, `@axes`,
  `@AXISNAME_indices`) and legacy (`signal=1`, `axes="Qh:Qk:Ql"`)
  attributes, in any array order. Axes named h/k/l (`Qh`, `H (r.l.u.)`,
  ...) or projections like `[H,H,0]` give an hkl grid; `Qx`/`Qy`/`Qz` in
  1/Angstrom give Cartesian Q, converted to hkl with the parent cell. Axes
  may hold points or bin edges and must be evenly spaced. A `weights`
  dataset divides the signal (zero weight becomes NaN). The cell, Laue
  group, temperature and wavelength are read from the entry's sample and
  monochromator groups when present. For NXrefine, whose data sit in
  separate files behind external links, select those files together with
  the main one: they are placed where the links expect them.
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

The page is a workspace: four cards on the left (data, unit cell,
processing, output), a preview and the log on the right, and a bar at the
bottom with the output file name, progress, Cancel and **Convert &
download**. The theme button switches between light and dark (the choice is
remembered; by default the page follows the system).

1. **Data**: drop files anywhere on the page, or choose them. The format is
   detected from the content; the card then shows the grid, its hkl range
   and step, the precision and the share of measured voxels, and the
   reader's notes. Dropped `.json` files load as recipes, `.rmc6f` files as
   structures, and Scatty or Spinteract configs as the grid config. For
   NeXus data kept in linked files, select or drop all of them at once;
   when a NeXus file holds several NXdata groups, pick one from the list.
   The grid config and the Yell data-space override sit under *More input
   options*.
2. **Unit cell**: choose where the parent (crystallographic) cell comes
   from: the data file, a structure file (`.rmc6f`: the supercell divided by
   its dimensions; a unified structure `.h5` stores the parent cell
   directly) or manual entry (a, b, c in Angstrom; alpha, beta, gamma in
   degrees). The card picks the data file's own cell when it has a real
   one, and warns when a structure file's cell differs from it. The text
   and VTK formats store no cell, and some Yell files store only the unit
   metric; see the table below.
3. **Processing** (optional): add steps, start from a preset, or load a
   saved recipe. Each step opens to show its parameters, can be switched off
   without losing them, dragged by its icon to another place, and removed;
   Undo (or Ctrl+Z outside text fields) steps back through changes, and the
   JSON view edits the whole recipe as text. See Processing below.
4. **Output**: pick the format card; for HDF5 output, also the precision
   (the same as the input, float64 or float32), the unified layout (both
   `/scattering/data` and `/entry/data`, or `/entry/data` only, which
   halves the file), gzip compression and the radiation metadata. Formats
   that cannot hold the result (the text formats for a 3D-ΔPDF) are
   disabled with the reason. The *|Q| profile* output writes the mean of the
   finite voxels in |Q| shells of the chosen width, with the standard error
   of the mean and the voxel count (`Q mean_I sigma_of_mean n_voxels`).

**Preview**: the planes of the grid as read, and after the recipe
(*After recipe* runs it once; Convert then reuses the result). A slider
moves through the planes; the colour scale is viridis on a log or linear
robust range, blue–orange and centred on zero for a 3D-ΔPDF, and grey marks
voxels without data; a histogram of the slice sits under it. Pointing at the
slice reads out its coordinates and value; a click pins that point, and the
other planes then go through it. The slice also works from the keyboard:
arrow keys move a cursor, Enter pins it, Page Up and Page Down change the
plane. The *|Q| profile* view plots the shell averages against |Q|, with
their standard error, for the data as read or after the recipe.

Text output (`.dat`, `.vtk`, profiles) is streamed directly to disk in
browsers that support the File System Access API (Chromium); elsewhere a
chunked in-memory download is used. The log reports the expected output
size first, and reading, processing and writing show progress and can be
cancelled. The log can be copied or downloaded.

### Large files

Data files are read without first loading them into memory: HDF5 files
are mounted in the worker and read slab by slab, and text files are parsed
as a stream (an 860 MB, 10-million-row `.dat` reads in about 5 s). Text
files are parsed once when loaded; changing the cell afterwards needs no
re-read. The limits are the browser's: the volume itself must fit in
memory, and an HDF5 output file is assembled in memory, which Chrome and
Edge cap at about 2 GB; float32, the `/entry/data`-only layout or
compression reduce it. Text output streamed to disk has no such limit.
Processing holds a few copies of the volume, and the 3D-ΔPDF about 64
bytes per voxel more.

### When is the unit cell required?

| Input | Cell needed? |
| --- | --- |
| Unified `.h5` with a real cell | no |
| Yell `.h5` with a real cell | no |
| Yell `.h5` with unit metric | yes (for `.dat`/`.vtk` output; passed through for HDF5 output) |
| Old text `.dat` | yes, always |
| Q-space `.vtk` (Scatty, Spinteract) | yes, always |
| r.l.u. `.vtk` (3DSCalculator, Scatty supercell) | yes (for `.dat`/`.vtk` output; passed through for HDF5 output) |
| Mantid `.nxs` with an oriented lattice | no |
| NeXus NXdata, hkl axes | no if the file stores a cell; otherwise as for unit metric |
| NeXus NXdata, Cartesian Q axes | yes, unless the file stores a cell |

## Processing

The *Processing* panel applies a list of steps to the data before they are
written; the input file is never changed. The steps run in the order listed.
NaN marks masked or missing voxels throughout, and |Q| is Cartesian in
1/Angstrom with the 2*pi convention, computed with the parent cell.

| Step | What it does |
| --- | --- |
| Crop | keeps the points inside hkl ranges (grids along h, k, l; use Resample otherwise) |
| Resample | NaN-aware trilinear interpolation onto a new axis-aligned hkl grid |
| Rebin | averages blocks of voxels, skipping NaN |
| Mask Bragg positions | boxes (half-width in r.l.u.) or spheres (radius in 1/Angstrom) around integer hkl, for P, I, F, C, A, B or R lattices |
| Mask powder rings | voxels within ±w of given \|Q\| values |
| Mask values | values outside a range |
| Scale and offset | I × factor + offset |
| Background B(\|Q\|) | subtracts a constant, linear, a − b·c^\|Q\| or tabulated function of \|Q\| |
| Background from \|Q\| shells | subtracts the minimum or a percentile of each \|Q\| shell, optionally smoothed over neighbouring shells |
| Combine | subtracts, adds, multiplies or divides by another volume (times a factor), interpolated onto this grid if the grids differ |
| Replace low values | sets values below a threshold to a number or NaN |
| Symmetrize | averages over Laue-equivalent points (-1 to m-3m; hexagonal axes for the trigonal groups), or only fills empty voxels; can extend a partial grid to its symmetric images |
| 3D-ΔPDF | Fourier transform to direct space (below) |

The other volumes that *Combine* steps use (an empty-can measurement, a
calculated pattern, ...) are loaded under *Other volumes*, in any readable
format; a step names its volume by file name.

**Recipes.** The steps are plain JSON, for example

```json
{ "version": 1, "steps": [
    { "op": "combine", "operation": "subtract", "file": "background.nxs" },
    { "op": "symmetrize", "laue": "m-3m" },
    { "op": "maskBragg", "shape": "box", "size": 0.2 },
    { "op": "deltaPdf" } ] }
```

Recipes can be saved and loaded. Unified output of processed data records
the recipe in `/entry/process` (an `NXprocess` group; the JSON and a
readable list of the steps sit in its `recipe` `NXnote`), and reading such
a file lists the steps in the log.

**3D-ΔPDF.** The step computes P(r) = |det V| Σ I(q) exp(2πi q·r) over all
grid points q, where the columns of V are the grid steps, so P approximates
the Fourier integral whatever the sampling. P is evaluated on the direct
grid conjugate to the data: u, v, w in lattice units of the parent cell,
centred on the origin, with steps 1/(N·Δh) etc. for an hkl-aligned grid.
NaN voxels, such as masked Bragg positions, count as zero, and an optional
Tukey taper (0–1) softens truncation ripples. The largest imaginary part is
logged and dropped; it vanishes for centrosymmetric data, e.g. after
symmetrization. The FFT is [wgpuFFT](https://github.com/MaximEremenko/wgpuFFT)'s:
on the CPU in float64, or with WebGPU in float32 (errors about 1e-8 of the
peak on real data). Grids of up to 2^25 voxels (e.g. 321³) are accepted. The
result can be written as unified or Yell data only, since the text formats
hold reciprocal-space grids.

As an example, background subtraction, m-3m symmetrization, Bragg masking
and the 3D-ΔPDF of a 321 x 321 x 321 CORELLI volume take about 22 s in
Chrome, most of it symmetrization; the FFT itself takes 3.4 s on the CPU
and about 1 s on a GPU, including transfers.

## Examples

The `Examples/` folder contains one small synthetic dataset (cubic parent
cell a = 5.63 Angstrom, 5 x 5 x 5 grid, hkl from -1 to 1 in steps of 0.5)
written in every format the converter writes, plus a matching structure file:

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

- `index.html`, `css/app.css`, `js/app.js` — the browser app: markup,
  styles (light and dark themes) and the page logic, which starts the
  conversion worker.
- `css/fonts.css` — IBM Plex Sans and Mono embedded as data URIs (see
  Third-party code); `tools/vendor-fonts.mjs` regenerates it.
- `js/worker.js` — the conversion worker: file mounting, loading, conversion
  planning and output, driven by messages from the page.
- `js/converter.js` — format readers/writers and the cell/reciprocal-space
  math. Plain JavaScript with a UMD wrapper, also loadable from Node.js for
  testing.
- `js/processing.js` — the processing steps and recipes (UMD like the
  converter).
- `js/wgpu_fft_web.js` — vendored wgpuFFT browser build (see Third-party
  code); `tools/vendor-wgpu-fft-web.mjs` replaces it with a new build.
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
- 3D-ΔPDF: the transform is checked against analytic cases (a constant
  gives an origin peak of N·|det V| and zero at the other grid points; a
  plane wave gives peaks at ±r0), and in the browser against the same recipe
  run in Node. On a real 321³ CORELLI volume the browser output matches
  Node to 1e-16 of the peak with the CPU engine and to 2e-8 with the GPU.

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

`css/fonts.css` embeds IBM Plex Sans and IBM Plex Mono (latin and greek
subsets, from Google Fonts), because browsers do not load font files next
to a page opened from `file://`. They are under the SIL Open Font License
1.1, reproduced in [`fonts/IBM-Plex-OFL.txt`](fonts/IBM-Plex-OFL.txt).

`js/wgpu_fft_web.js` is a build of the browser bindings of
[wgpuFFT](https://github.com/MaximEremenko/wgpuFFT) (Apache-2.0), with the
WebAssembly module embedded, wrapped the same way in `wgpuFftWebModule()`.
It includes Rust crates under the Apache-2.0, MIT and zlib licenses; see
[`js/wgpu_fft_web-LICENSES.txt`](js/wgpu_fft_web-LICENSES.txt).

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
