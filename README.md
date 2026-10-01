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
| RMCProfile old text format (`.dat`, `_hkl.dat`) | yes | yes | RMCProfile Diffuse3D |
| RMCProfile amplitudes (`_aver_amp_calc.dat`, `_total_amp_calc.dat`, `_aver_interf_calc.dat`) | yes | no | RMCProfile |
| hkl list `h k l I σ` (`.txt`) | yes | yes | Spinteract (`_xtal_data_NN.txt`), Scatty (`scatty_data_01.txt`) |
| VTK `STRUCTURED_POINTS` (`.vtk`, ASCII or binary) | yes | yes | Scatty, Spinteract, 3DSCalculator; also loads in ParaView |
| VTK XML image data (`.vti`) | no | yes | ParaView 5.10+ (any grid, through its Direction matrix) |
| NumPy (`.npz`) | yes | yes | `np.load` in Python scripts |
| 3DSCalculator export (`.dat`, `.json`) | yes | no | 3DSCalculator (calculated or loaded intensities) |
| rspace3d volume (HDF5) | yes | no | rspace3d (CrysAlisPro unwarp layers stacked) |
| CCP4/MRC map (`.mrc`) | no | yes | ChimeraX, Coot, PyMOL (3D-ΔPDF maps) |
| NeXus: Mantid MDHistoWorkspace (`.nxs`) | yes | no | Mantid `SaveMD` (CORELLI, TOPAZ, WAND², DEMAND, SXD, ...) |
| NeXus: NXdata (`.nxs`) | yes | no | NXrefine (APS 6-ID-D, CHESS QM2), other NeXus writers |
| \|Q\| profile (`.txt`) | no | yes | shell averages of the (processed) volume |

Any readable format can be converted to any writable one. The input format
is detected automatically from the file content. Direct-space 3D-ΔPDF maps
(u, v, w axes) are read from unified, Yell and `.npz` files and written to
those, to `.vti` and to CCP4/MRC; the Q-space text formats cannot hold them,
and a CCP4/MRC map holds only them.

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
  kept as stored. Lines are read the way RMCProfile's Fortran reads them:
  values may be apart by blanks or commas, whatever follows the values a
  line needs is ignored (a comment after `npoints nsec`, an extra column),
  and a row may wrap over several lines. Fortran `D` exponents are
  accepted. Grid points missing from a file are read as NaN; when
  pixel (1,1,1) or its neighbours are among them, the grid geometry is
  fitted to all rows. On output, NaN or infinite intensities are written as
  0.0, which RMCProfile treats as a masked point (points with I = 0 are left
  out of the fit). The `_hkl.dat` variant (by its name) has hkl instead of
  Q coordinates and needs no cell; it can also be written. Output can list
  symmetry sections: for a chosen Laue group, each row then carries the
  coordinates of every symmetry-equivalent point (the point itself first)
  and the header gives their number as `nsec`.
- **RMCProfile amplitudes** (`*_amp_calc.dat`, by name): rows of `i j k`, a
  Q triplet and `Re Im` per symmetry section, without a header. The value
  read is |A|² averaged over the sections; when the file holds several
  `ipermutation` blocks (a file starting with one is taken as amplitudes
  whatever its name), the first is used. The interference function
  (`*_interf_calc.dat`: the Q triplets, then one `Re Im` per point) is read
  as |F|².
- **hkl lists**: rows of `h k l I` and optionally `σ` (Spinteract
  `_xtal_data`/`_xtal_fit`, Scatty `scatty_data_01.txt`/`_sc_list.txt`,
  `*_intensity3d_rmc_*.dat` tables). A first line of column names
  (`H K L Intensity`) is skipped. The grid is inferred from the rows (or
  taken from a Spinteract/Scatty config loaded as the grid config, for
  rotated grids); coordinates printed with few decimals (a 1/64 step as
  `-1.984 -1.969 ...`) go to their nearest grid point. Grid points without
  a row become NaN. On output, masked voxels are left out, σ comes from the
  data (1 with a warning when there is none), rows with σ ≤ 1e-8 are left
  out (Scatty stops on them), and the log shows the matching `ORIGIN`
  (Spinteract) or `CENTRE` (Scatty) config lines. The file is named as the
  target program expects.
- **3DSCalculator exports**: the `.dat` (`# h k l intensity`, then rows
  with l fastest) is read as an hkl list; the `.json` gives the grid from
  its `hAxis`/`kAxis`/`lAxis`, the intensities (l fastest, `null` for NaN)
  and the parent cell from the metric of `Bq` (`Q = [h,k,l] * Bq`), so its
  c-along-z Cartesian frame does not matter. A `.json` dropped on the page
  is taken as data when it has 3DSCalculator's keys, else as a recipe.
- **rspace3d** (HDF5 with `/data`, `/H`, `/K`, `/L`): the volume rspace3d
  builds from CrysAlisPro unwarp layers, NaN where unmeasured. The cell
  comes from the `cell_*` attributes, else from `UB` over the wavelength.
  Unwarp rasters are Cartesian, so for an oblique cell one in-plane index
  also moves along the other; the shear (from `M_inv`, or from the cell) is
  kept as a sheared hkl grid, and crop on read then does not apply. Data
  rspace3d symmetrized are labelled so; the radiation is set to x-ray.
- **NumPy `.npz`**: an uncompressed archive (read it with `np.load`) of
  `values` and, when known, `sigma`, as C-order arrays `[nl, nk, nh]`
  (`values[l, k, h]`), `corner`, `step_vectors` (one row per grid axis),
  `unit_cell` (a b c alpha beta gamma) and `metadata.json` (axes, content,
  radiation, symmetrization). NaN stays NaN. The point `values[i2, i1, i0]`
  sits at `corner + i0*step_vectors[0] + i1*step_vectors[1] +
  i2*step_vectors[2]`. Files written with `np.savez` under these names read
  back; `np.savez_compressed` archives are refused.
- **VTK XML `.vti`**: `ImageData` with a `Direction` matrix, so sheared and
  rotated grids keep their shape in ParaView 5.10 and later. Axes are
  Cartesian Q in 1/Angstrom (a∥x, as for the text formats) for hkl data with
  a real cell, Cartesian Angstrom for a 3D-ΔPDF, and r.l.u. (or lattice
  units) without a cell. `values` (and `sigma`) are stored as base64 binary
  in float32 or float64; NaN is kept.
- **CCP4/MRC** (MRC2014, float32): for direct-space grids along u, v and w,
  i.e. a 3D-ΔPDF. The map cell spans the grid, so a voxel is one grid step;
  `NXSTART`... place the origin, which must be a whole number of steps from
  the grid corner. Empty voxels are written as 0.
- **VTK**: `STRUCTURED_POINTS`, ASCII, or binary (big-endian float32) on
  request. In Scatty (`*_sc.vtk`) and Spinteract
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
  neutron. Workspaces in the Q (sample frame) are put on hkl axes through
  their own UB (`oriented_lattice/orientation_matrix`): hkl = (2π UB)⁻¹ Q,
  with the sign of Q from `QConvention` (−1 for Mantid's default Inelastic
  convention) — a sheared hkl grid, exact; this is checked on synthetic
  files only, as no real Q-frame workspace was at hand. A fourth dimension
  (DeltaE) integrated into one bin is fine. Q (lab frame) workspaces,
  open 4-D ones, MDEventWorkspaces, event workspaces and raw instrument
  files are refused with an explanation.
- **NeXus NXdata**: the group named by the `@default` attributes is read,
  or another one chosen from the list that appears when a file holds
  several. Signals and axes are found from the current (`@signal`, `@axes`,
  `@AXISNAME_indices`) and legacy (`signal=1`, `axes="Qh:Qk:Ql"`)
  attributes, in any array order. Axes named h/k/l (`Qh`, `H (r.l.u.)`,
  ...) or projections like `[H,H,0]` give an hkl grid; `Qx`/`Qy`/`Qz` in
  1/Angstrom give Cartesian Q, converted to hkl with the UB matrix when
  the file (`sample/ub_matrix`) or the Cell card gives one, else with the
  parent cell (a along x). Axes
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

### Command line

The same readers, processing and writers run from Node.js 22 or later,
for scripts, series and outputs above the browser's 2 GB:

```
node cli/3dsconvert.js data.nxs --to unified
node cli/3dsconvert.js scan_*.nxs --to npz --out-dir converted --crop h=-6:6,k=-6:6,l=-2:2
node cli/3dsconvert.js data.nxs --to unified --recipe corelli.json --extra background.nxs
node cli/3dsconvert.js data.dat --to vti --structure model.rmc6f
```

`--help` lists the options: they are the page's (cell, structure file,
recipe and its extra volumes, crop on read, uncertainties, precision,
layout, gzip, the per-format choices). Several inputs are converted one
after another with the same settings, and a file that fails does not stop
the others; the exit code is 1 if any failed. Text output is streamed to
disk; HDF5 output is built in memory, so its size is limited by the RAM
(a 2.9 GB unified file from a 1.1 GB Mantid workspace took 16 s). Existing
files are kept unless `--force` is given.

## Usage

The page is a workspace: four panels on the left (data, unit cell,
processing, output), the preview and the log on the right, and a bar at the
bottom with the output file name, progress, Cancel, **Series…**,
**Process** and **Download**. **Process** runs the recipe and shows the
result in the preview; **Download** writes the output file, running the
recipe first unless Process already did with the same data, cell and
recipe. The theme button switches between light and dark (the choice is
remembered; by default the page follows the system).

The layout is yours to change, and this browser keeps it: drag the bar
between the columns to share the width, and the bar above the log to share
the height with the preview (a double-click on a bar resets it). A panel
moves by the grip at the left of its title: drag it to another place in
either column, or focus the grip and use the arrow keys (up and down in the
column, left and right to the other one). The layout button in the top bar
swaps the columns or resets everything. In the column that stays in view,
the preview takes the height the other panels leave, and the plot grows
with it.

1. **Data**: drop files anywhere on the page, or choose them. The format is
   detected from the content; the card then shows the grid, its hkl range
   and step, the precision and the share of measured voxels, and the
   reader's notes. Dropped `.json` files load as recipes (3DSCalculator exports as data),
   `.rmc6f` files, unified structure files and subhkl `indexer.h5` files as
   structures, and Scatty or Spinteract configs as the grid config. For
   NeXus data kept in linked files, select or drop all of them at once;
   when a NeXus file holds several NXdata groups, pick one from the list.
   The grid config and the Yell data-space override sit under *More input
   options*.
2. **Unit cell**: choose where the parent (crystallographic) cell comes
   from: the data file, a structure file (`.rmc6f`: the supercell divided by
   its dimensions; a unified structure `.h5` stores the parent cell
   directly; a subhkl `indexer.h5` gives its refined cell) or manual entry (a, b, c in Angstrom; alpha, beta, gamma in
   degrees). The card picks the data file's own cell when it has a real
   one, and warns when a structure file's cell differs from it. The text
   and VTK formats store no cell, and some Yell files store only the unit
   metric; see the table below.
3. **Processing** (optional): add steps, start from a preset, or load a
   saved recipe. Each step opens to show its parameters, can be switched off
   without losing them, dragged by its icon to another place, and removed;
   Undo (or Ctrl+Z outside text fields) steps back through changes, and the
   JSON view edits the whole recipe as text. See Processing below.
4. **Output**: pick the format card, then its options; options a format
   does not use are greyed out. The precision (the same as the input,
   float64 or float32) applies to HDF5, `.npz` and `.vti`; the unified
   layout (both `/scattering/data` and `/entry/data`, or `/entry/data` only,
   which halves the file) and gzip compression to HDF5; the radiation to
   HDF5 and `.npz`. The `.dat` output takes Q or hkl coordinates and
   optional symmetry sections, VTK ASCII or binary, and the hkl list its
   target program. Formats that cannot hold the result (the Q-space text
   formats for a 3D-ΔPDF, CCP4/MRC for Q-space data) are disabled with the
   reason. The *|Q| profile* output writes the mean of the
   finite voxels in |Q| shells of the chosen width, with the standard error
   of the mean and the voxel count (`Q mean_I sigma_of_mean n_voxels`).

**Preview**: the planes of the grid as read, and after the recipe
(*Processed*, or Process in the bottom bar, runs it once; Download then
reuses the result, and a recipe change marks it out of date). A slider
moves through the planes, and the box beside it takes a typed position. The
colour scale is viridis on a log or linear range, blue–orange and centred on
zero for a 3D-ΔPDF, and grey marks voxels without data; a histogram of the
slice sits under it. The levels come from the whole volume and stay while
you move through the planes; typed levels stay likewise until *auto*, and
*per slice* scales each plane on its own.

- **Custom** planes are cut as 3DSCalculator and 3DSView cut them: a
  normal n you type (in the grid coordinates: [0 0 1] gives the (h k 0)
  planes, [1 −1 0] the (h h l) ones; for a 3D-ΔPDF they are u, v, w), a
  point the plane goes through (the middle of the data, a pinned point, or
  one typed under *through*), and t, the distance along the unit normal
  from that point. The slider has 401 positions from corner to corner of
  the data; a typed t may be anything between. The image axes u and v are
  orthonormal in the grid coordinates, with v up along the projection of l
  (else k) and u = v × n, and the pixels are square there, about a voxel
  each, so an (h h l) plane is √2 wider than high and a (1 1 1) cut through
  a cube is a regular hexagon. The axis coordinates are the components of
  the point along u and v; a normal along an axis keeps that axis plane's
  layout.
- **Cartesian (UB)** redraws any plane on a square grid in Cartesian space,
  Q = 2π UB hkl, so angles and lengths are true (a hexagonal (h k 0) plane
  shows its 120°). Without a UB the cell sets the frame, with a along x; a
  3D-ΔPDF is drawn in Å. The UB comes from the data file (Mantid's oriented
  lattice, NeXus `sample/ub_matrix`, rspace3d), from a subhkl structure
  file, or is typed under *Orientation (UB matrix)* in the Cell card.
- **Zoom**: the wheel or + and − zoom about the pointer, dragging pans, and
  0, a double-click or the 1:1 button shows the whole plane; the zoom stays
  while the slider moves. The |Q| profile zooms and pans along |Q| the same
  way.

Pointing at the slice reads out the three coordinates of the point, its
value and, in the Cartesian frame, |Q|; a click pins the point, and the
other planes then go through it. The slice also works from the keyboard:
arrow keys move a cursor, Enter pins it, Page Up and Page Down change the
plane, + − 0 zoom. The *|Q| profile* view plots the shell averages against
|Q|, with their standard error, for the data as read or after the recipe.

Text output (`.dat`, `.vtk`, `.vti`, hkl lists, profiles) is streamed directly to disk in
browsers that support the File System Access API (Chromium); elsewhere a
chunked in-memory download is used. The log reports the expected output
size first, and reading, processing and writing show progress and can be
cancelled. The log can be copied or downloaded.

**Series…** (in the bottom bar) converts several files, one after another,
with the page's current cell source, recipe (and its extra volumes), crop
and output settings — a temperature or composition series. In Chromium the
outputs go into one folder you pick; elsewhere each is downloaded. A file
that fails is reported and the series goes on; Cancel stops it. The data
loaded in the page stay as they were.

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
| `_hkl.dat`, hkl list | yes (for Q-frame `.dat`, `.vtk` and CCP4/MRC output; `.vti` then stays in r.l.u.) |
| `.npz` written by 3DSConvert | no (it stores the cell) |
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
| Correct the UB | puts the Bragg peaks back on integer hkl: *refine* finds the peaks near integer positions (half-maximum centroids within a search radius, a robust signal-to-noise cut), fits the linear map (optionally with a shift) that takes them to the integers by least squares with one round of outlier rejection, and resamples the volume on its own grid; *matrix* does the same from the UB the grid was made with (else the data's) and a corrected UB. The data's UB is corrected too. Run it before any Bragg mask |
| Mask Bragg positions | boxes (half-width in r.l.u.) or spheres (radius in 1/Angstrom) around integer hkl, for P, I, F, C, A, B or R lattices |
| Mask powder rings | voxels within ±w of given \|Q\| values, or of the powder lines of an aluminium, copper or vanadium sample holder (from its lattice parameter, room temperature by default) |
| Mask \|Q\| range | voxels outside min ≤ \|Q\| ≤ max (the beam stop, the corners of the grid) |
| Mask values | values outside a range |
| Fill empty voxels | empty voxels next to data take the mean of their measured neighbours, n layers deep |
| Scale and offset | I × factor + offset; optionally then shifted up by 1.01 × the lowest value, so every value is positive (RMCProfile reads I = 0 as masked) |
| Smooth | Gaussian, σ in voxels; empty voxels neither count nor get filled; uncertainties are dropped |
| Despike | a voxel more than k robust σ (1.4826 × the median absolute deviation) from the median of its 3×3×3 (or 5×5×5) neighbourhood takes that median; k = 0 makes it a median filter. Single-voxel Bragg peaks of calculated patterns count as spikes |
| Normalize by Mantid norms | Σdata/Σnorm − s·Σbkg/Σbkg_norm from MDNorm's component volumes, summed over Laue equivalents if asked; s given, or fitted by least squares of data/norm against bkg/bkg_norm (on real CORELLI data the fit comes out near 0, so check it) |
| Background B(\|Q\|) | subtracts a constant, linear, a − b·c^\|Q\| or tabulated function of \|Q\| (two table rows at one \|Q\| make a step) |
| Background from \|Q\| shells | subtracts the minimum or a percentile of each \|Q\| shell, optionally smoothed over neighbouring shells |
| Background: Laue + thermal | the diffuse scattering of uncorrelated disorder, per formula unit Σ over sites of count × (⟨f²⟩ − ⟨f e^−W⟩²) with 2W = Uiso Q²: the Laue term of species sharing a site and the thermal diffuse scattering the Debye–Waller factors take from the Bragg peaks. The composition is written as sites, e.g. `Pb; Mg 0.333 + Nb 0.667; 3*O` (occupancies; what is missing to 1 is vacancy), with Uiso for all or per element (`0.01, Pb 0.03`); X-ray (Waasmaier–Kirfel), neutron (coherent lengths) or electron (Peng) scattering, from 3DSCalculator's tables. It is scaled by least squares to a low percentile of each \|Q\| shell (with an offset if asked), or by a given factor |
| Remove powder rings | the rings of named materials - sample-environment metals (aluminium, copper, vanadium, niobium, titanium, zirconium, beryllium, ...), ice, calibrants (Si, CeO2, LaB6, ...) or a custom `fcc Al 4.05` - are predicted from their structure and fitted to the data, then subtracted at their \|Q\| from every voxel, so anisotropic diffuse scattering stays; `any` removes every ring sharper than a cutoff instead. See below |
| Ring filter at the lines | a Fourier filter, on the lines of named materials only, of what a ring removal leaves (or of the rings themselves), over \|Q\| and the angle to the crystal's rotation axis. See below |
| Combine | subtracts, adds, multiplies or divides by another volume (times a factor), interpolated onto this grid if the grids differ |
| Replace low values | sets values below a threshold to a number or NaN |
| Symmetrize | averages over Laue-equivalent points (-1 to m-3m; hexagonal axes for the trigonal groups), or only fills empty voxels; *median* takes the median of the equivalents and *clip* their mean without those more than k robust σ from it, so a spike or a spurious peak in one equivalent drops out. The grid is extended to its symmetric images (a half volume becomes whole) unless that is switched off; a grid that already holds them stays as it is |
| \|Q\| window | multiplies by a Lorch (sin x / x), Hann or Gaussian window in \|Q\| up to qmax (by default the largest sphere inside the grid), or keeps a sphere; voxels beyond become empty. Before a 3D-ΔPDF it damps the truncation ripples of the box's edges |
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

**Powder rings.** For each material the lines come from its structure:
every reflection's integrated intensity m\|F\|²·exp(−2W) (X-ray, neutron or
electron form factors, a Debye–Waller B) spread over the sphere of its
\|Q\|, so a line's strength in a reciprocal-space volume is Σ\|F\|²/(4πQ²),
with no Lorentz or polarization factor (for aluminium and neutrons the
(111) : (200) : (220) : (311) : (222) lines come out 100 : 55 : 49 : 66 :
20). The library holds sample-environment metals, ice Ih (H₂O, D₂O) and
cubic ice, and calibrants, with lattice parameters from COD entries, NIST
certificates and CODATA; aluminium can be given its temperature (NIST's
expansion fit for 6061-T6), and then the fitted lattice parameter checks
the data's \|Q\| scale, the sample cell.

The data enter as a robust profile, the median of every \|Q\| bin, with its
uncertainty 1.2533 × 1.4826 × MAD/√n, over whole shells and over direction
sectors (8 by default). The bins are equal in the coordinate
u = asinh(rQ/σ₀)/r, in which a line of width σ(Q) = √(σ₀² + (rQ)²) is one
unit wide everywhere: u follows \|Q\| where the width is constant
(monochromatic area detectors) and ln\|Q\| where it grows in proportion
(time of flight). The same Gaussian high-pass (six line widths by default)
is taken off the profile and off the model, so a smooth background and
broad diffuse features drop out of the fit; applying it to the model too
keeps the amplitudes unbiased. The amplitudes follow from non-negative (or,
after an empty-can subtraction, signed) Huber-weighted least squares, with
one-dimensional searches for each lattice parameter (±1 % by default) and a
joint search for σ₀ and r; the profile is rebuilt for the fitted widths when
they end at a bound. By default every line has an intensity of its own
where it is significant (texture and absorption change the ratios) and a
weak one keeps the structure-factor ratio. A material is left out, and
logged, when its lines explain under 2 % of the high-passed profile, show
no clear lattice match or give fewer than two significant lines. Only the
bins near the lines (anywhere in the lattice search) judge the fit, and no
uncertainty counts below a quarter of their median: in a symmetrized volume
the shells near the origin hold copies of a few values, whose tiny
uncertainties would otherwise outweigh the rings (on a CORELLI m-3m volume
at 533 K aluminium was not found before). An empty-can subtraction that
took off more than the rings leaves them negative, and it can leave one
material positive and another negative: the materials the positive fit
does not find are tried again, with negative intensities only, on what it
leaves, under the same significance and lattice tests; lines of either sign
within one material need *positive* off. The non-negative fit is solved
exactly (an active set that takes a line back in whenever it would lower
the loss). A sector
fits its own amplitudes when they beat one scale on the whole-shell lines
by more than their number (Akaike's criterion); the subtraction blends the
sectors smoothly by direction, so no seams are left. In binned data a voxel
holds the mean over its extent, which widens a line along the direction n
by √(Σᵢ(qᵢ·n)²/12) (qᵢ the voxel's steps in Q); this term is on by default
and is to be switched off for point-sampled, calculated volumes. A part of
the sample environment off the sample position moves its lines with the
direction: each sector may shift its lines (by up to 0.2 % by default),
kept only when that fits better by more than its cost and by more than a
tenth of a line width. Large grains (beryllium windows, annealed copper)
leave bright spots on a ring that no smooth model takes off; *mask spots*
then empties the voxels on a line's core more than four robust σ above the
median of that line in that sector. On a CORELLI volume in an aluminium can
the fit gives a = 4.0494 Å (0.006 % from aluminium at 300 K) and removes
98–102 % of the (111), (200) and (220) ring excess on average over
directions; what it leaves varies with direction, which the ring filter
below takes off. The *Sample-environment rings* preset runs both for
aluminium and copper.

Both ring steps take *protect*, the name of a volume loaded under Other
volumes on the same grid (or `--extra` in the command line): its voxels with
positive values - planes, rods or spots of the sample that cross a ring -
are left out of every estimate and keep their measured values.

**Ring filter.** In data from a crystal turned about one axis a ring of the
sample environment depends on \|Q\| and on the angle to that axis - a
detector pixel sees the ring at one angle to the axis at every turn, so
detector edges and gaps, the resolution and the paths through the
environment draw bands in that angle, some only a degree or two wide - and
only smoothly on the azimuth about it. The eight direction sectors of the
fit cannot follow such bands, nor line shapes that are not Gaussian (the
asymmetric lines of time of flight). The filter takes what the fit leaves
as a function of those coordinates: medians in bins of the angle to the
axis (1° by default) and of the fit's coordinate u, band-passed along u by
FFT (what is broader than four line widths, and the noise finer than 0.4
of a width, come off), smoothed over the angle (more widely where the bins
hold few voxels, near the axis), then the same over coarse cells of angle
and azimuth for the Fourier orders up to 4 about the axis; three passes.
Optionally (*local*, off by default), the ring's strength is then fitted
locally: a can's ring varies along itself (texture, large grains) more
finely than that angular model, but narrow planes or rods of the sample have
the same profile across the ring, so the fit can take them too. Over
patches of directions holding about 30 voxels each (their angle grows as
1/|Q|), Huber-weighted least squares of the voxels within four widths of a
line on a quadratic background and the line's profile give the amplitude
left there - the scattering that crosses a ring is broad across it, so the
background takes it - shrunk by its significance, held within the ring's
height, smoothed over neighbouring patches and interpolated between them.
Patches round the sample's reflections at the line's |Q| are not fitted.
The axis is found from the rings - a Legendre fit of the line excess over
300 direction cells gives a first axis, refined to where the excess binned
by a degree of angle is sharpest (on CORELLI data 0.26° from the vertical
goniometer axis of the UB) - or given as h k l. The medians leave out the
voxels within 0.3 r.l.u. of the sample's Bragg positions, whose diffuse
clouds sit at the rings' \|Q\| when the lattices are alike (perovskites near
4 Å, aluminium 4.05 Å), and the bins whose circle about the axis the edge of
the grid cuts. A line is filtered when what is left on it stands out of the
estimate's noise (the same table from every other voxel tells how large
that is) and, after a fit, is less than half its ring; otherwise it is left
alone and logged, as more is the sample's own scattering. Only the voxels
within three line widths of those lines change. Lines, positions and
widths come from a ring removal earlier in the recipe, or from a fit of the
filter's own (alone it leaves the broad foot of a strong ring, about a
third of it: run it after the removal). On the CORELLI volume of PMN-PT in
aluminium the scatter of the ring excess over 300 directions, in units of
its errors (χ²/n; 1–2 where there are no rings), goes from 78, 25 and 20 at
Al (111), (200) and (220) after the fit to 17, 6 and 4 after the filter
(5.3, 4.0 and 1.7 with the local strengths; 1.2-1.8 where there are no
rings); in
the half-integer planes the (111) ring, 0.12 high, leaves less than 0.005.
What remains has none of the crystal's symmetry: ring structure that
changes with the azimuth faster than the fourth order, and the broad part
of lines in the narrow bands at the detector edges, which a high-pass of
four line widths cannot tell from the sample's scattering. On a synthetic
volume with bands and asymmetric lines the (111) residual falls from 0.036
after the fit to 0.009, against noise of 0.02, with the sample near its
Bragg peaks unchanged.

**Rings and symmetry.** A can's rings are ordered about the rotation axis,
not by the crystal's symmetry. Taken off after symmetrizing, they have lost
that order (the filter then works as a smooth angular model) and a faint
material may go unfound; taken off before, the fit and the filter, being
robust, leave the bright spots of large grains, which symmetrizing averages
over the 48 copies into a broad ring. On the 533 K CORELLI volume of PMN-PT
both orders leave the aluminium lines at χ²/n 1.6-4.8 (3.0-6.3 at the
sample's own shells), but symmetrizing first loses the copper, and removing
rings first leaves copper (111) at 28, against 2.8 before symmetrizing. A
second ring filter after symmetrizing, which takes the lines of the first
fit, brings that to 3.0 with aluminium at 1.4-4.4; *mask spots* in the first
removal also helps (19), at some cost to the sample's scattering on the ring
cores. Symmetrizing without outliers (mode *clip*) keeps the spots out of
the average - the copper (111) excess of the symmetrized volume as read
stays that of the measured one (0.017; 0.032 with *average*) - and with the
second filter no line is left above 4.8 (aluminium 2.1-4.8, copper 4.8 and
3.5, against 2.9-5.1 at the sample's own shells). The preset *Rings, then
symmetrize* runs the fit, the filter and the symmetrization without
outliers; the second filter, and the local strengths, are to be added after
a look at the result, as they do not help the sample's scattering
everywhere. It also serves a volume that was symmetrized already: the
filter, working about one axis, breaks the symmetry a little, and the
symmetrization puts it back (on Mantid's m-3m volume at 533 K, with the
second filter, aluminium 2.1-6.1 and copper 1.7 and 1.4, against 2.7-6.7 and
2.4 and 1.4 with the fit and filter alone). The spots such a volume has already averaged in stay as
ring intensity, and a faint material may go unfound. A second ring fit after symmetrizing finds nothing:
what is left is no line of the fitted shape. Symmetrized, an empty-can
volume has a comb of maxima along each ring, which a subtraction carries
into the sample's volume (the streaks along h and k in the half-integer
planes of symmetrized, can-subtracted CORELLI volumes).

Recommended order: subtract an empty-can measurement if there is one (both
volumes unsymmetrized, on one scale), then remove the remaining rings and
symmetrize without outliers (the preset *Rings, then symmetrize*), filter
the rings once more if they still show, then treat the Bragg peaks (mask,
punch and fill) and compute the 3D-ΔPDF. `any` instead removes every ring sharper
than a cutoff, for phases that are not in the library.

The method takes the angular low-pass of ring filters for images (rings
have no angular frequency: Münch et al., Opt. Express 17, 8567 (2009),
whose Fourier damping of stripes in sinograms the ring filter applies on
the plane of \|Q\| and the angle to the rotation axis;
the azimuthal medians of DIALS, Parkhurst et al., IUCrJ 4, 626 (2017), and
of pyFAI) into three dimensions, and fits the lines as ice-ring tools and
Le Bail fits do (AUSPEX, Thorn et al., Acta Cryst. D73, 729 (2017)).

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
- `cli/3dsconvert.js` — the command-line tool: runs the worker core in
  Node.js, reading input files from disk as needed.
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
