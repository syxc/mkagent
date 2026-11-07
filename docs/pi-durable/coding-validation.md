# Pi-durable coding agent validation and remaining work

This report keeps the implementation and checks at `4776fe1` and records later
work separately. The target is
`pi-durable coding agent`: pi-durable execution, Pi coding capabilities and
plugin compatibility, with all existing MkAgent features preserved. The
[implementation plan](durable-coding-agent-plan.md) defines the remaining
corrections and acceptance gates after the user's clarification on 2026-11-04.
Confirmed missing required operations and missing validation are recorded
separately. Unverified combinations alone do not establish a functional defect
or expand the scope of this architecture work.

The review on 2026-11-06 uses code baseline `f4f9f26`. The pi-durable kernel is
already integrated. Most Coding functionality has implementation and historical
evidence; its completeness still requires verification. The current
priority is to reuse pi-durable built-ins, then use independent packages for
missing capabilities, and retain thin adapters only where contracts still differ.
The [follow-up list](coding-follow-up.md) records the revised work and the
blocked source checks. Normal-profile AgentSession and projection requirements
were unsupported assumptions; the candidate runtime changes were withdrawn.
The baseline product test then passed with 1 test and 43 assertions.

## Shared Native edit differences

Native edit matching, replacements, line-ending conversion and diff display now
forward through nine public durable functions. The Native module retains its
function signatures, seven type declarations and both file-preview functions.
The preview declarations are unchanged. Native public interfaces remain local,
so declaration merging still reaches the function return types.

All 18 shared function bodies match the original durable functions after
TypeScript erasure and comment removal. The 19 runtime files of the two
resolved `diff` copies match byte for byte. The patch only adds exports to
`tools/index.js` and its declaration file; durable's edit implementation and
types match the original cached package. The Native source falls from 556
lines to 186 lines, including its retained types, documentation and forwarding
functions. No dependency is added.

| Check | Result and scope |
| --- | --- |
| Original behavior | Before production changes, Bun and Node capture the same 305 result and error digests from source `f85a9809eb44b9828236050cf38a8e45933e5cfd583a186e9a0e55a664dd3e8d`. Cases cover exact and fuzzy matching, unchanged lines, disjoint and overlapping edits, duplicate and absent text, no-change errors, CRLF, BOM, Unicode, surrogates and unusual diff context limits. |
| Native entry points | Before and after sharing, 312 tests and 623 assertions pass in Bun. Real temporary files cover BOM/CRLF previews, unordered edits, duplicate errors and missing files. A checked permission substitute verifies `R_OK`, the requested path and the original diagnostic. Resolution errors still reject outside result conversion. Previews leave file bytes unchanged. |
| Types and generation | Twelve explicit strict roots, 445 source files, zero diagnostics. The roots include Native interface augmentation for matching and edit results. Twenty-three declaration and import mutations are rejected. Seven Native types and both preview bodies remain intact. |
| Scoped reproduction | `vendor-coding-runtime.ts --check --file=core/tools/edit-diff.ts` passes with one source file and `complete: false`. No full runtime traversal runs. |
| Patch replay | The complete 30-file patch applies cleanly and matches the installed files. The other 28 file diffs remain unchanged. Patch SHA-256 is `b7d6b9840679e0dd61f492f390d3aa24b61915e81da57195090070458b01aa61`; body SHA-256 is `df30f6cfbdf36c30f98171c2449b68e9075c89de4d85164e806b8b353f1f87bb`. |
| Fresh frozen consumer | A new consumer installs 99 original cached packages offline with `--frozen-lockfile --ignore-scripts`. All 30 patched files, 23 Native files and 68 files in the audited Bun runtime closure match. Both lockfiles remain unchanged. |
| Consumer execution | Bun and Node each pass the same 1235 tests across shell, read paths, truncation, normalization and edit differences. Bun reports 2518 assertions. Node uses the same test bodies with the existing builtin-module and assertion adapter. |
| Review | Main-thread review covers all changed production, generation, fixture and patch files. No review is delegated. The Bun import audit reports 68 files, down from 87 before sharing, with no nonliteral imports. |

These checks exercise the pure public functions and real Native file previews.
They do not instantiate the complete edit-tool definition, its renderers or
the plugin loader. Full SDK, product, source and platform checks retain their
existing restrictions. F1/F3 remain open.

## File mutation and HTML candidates after b796f2c

The file-mutation queue has two prototype adapters. An environment
adapter preserves Native path resolution, separate queue identity and
serialized key registration while calling durable's queue. Under both Bun and
Node, 33 invariant checks cover the original, environment and synchronous-slot
implementations. Cases include existing aliases, missing paths, `ENOTDIR`,
different-file parallelism, delayed keys, callback failure, key-error identity,
registration recovery and nested operations on different files.

The environment adapter adds awaits and changes a controlled `realpath`
substitute's ordering. Native starts callback A before key B finishes; the
adapter finishes key B first. A simulated file creation also changes whether
operation B waits for A. A synchronous reservation factory extracted from the
existing durable allocation and cleanup statements preserves both observed
results. That alternative changes Native from 61 to 50 lines and durable from
52 to 61 lines. It saves two runtime lines in total, before public declarations,
exports and generation guards. The original production implementations remain
unchanged. This is a maintenance-cost decision after testing both adapters,
not a claim that protocol adaptation is impossible.

The existing public `html-entities@2.6.0` XML mode differs from Native for NUL,
C1 controls, U+10FFFF, invalid numbers and `#0x10`. A named-entity-only adapter
preserves the original numeric parser, scanner and JavaScript error behavior.
It matches 20434 complete value/error comparisons in each runtime, including
scanner offsets, length limits and malformed entities. Native would change
from 51 to 48 lines while adding a direct runtime dependency for five names.
The original module remains unchanged.

The first HTML audit expected a literal table and rejected its pure reference
generator. The first comparison launches then failed because the candidate
file had not been created. After inspecting that generator and its calls, the
harness generated the candidate and both runtime comparisons passed.

The manifest contains 257 records: 248 TypeScript files and nine assets.
This count does not establish the necessity of all recorded sources.
The inspected user-agent helper already calls public pi-ai. Git parsing
already uses `hosted-git-info`; output-file creation keeps exclusive `wx` and
0600 permissions through Node APIs. Tool-result image handling keeps Native
array identity and failure policies around the existing image pipeline.
Their remaining source necessity has not been established by these probes.
Full SDK, product and source checks retain their existing restrictions.

## Remaining truncation candidates

A prototype uses public chord `boundOutput` for the Native partial tail and
`characterEnd` for the middle prefix. It matches 875 original cases plus 240
fractional, negative, infinite, BOM and surrogate boundary cases under both
Bun and Node. The adapter retains Native replacement characters when a
fractional byte limit keeps the entire encoded buffer.

The prototype also adds encoding and line scans for the partial tail. Three
fresh Node processes per case measure the first call through the actual
production module composition, after module import. For 10 MiB inputs, the
production and candidate medians are 7.59ms and 14.68ms for ASCII, and 32.04ms
and 39.46ms for Unicode. Output digests match. These samples do not establish
performance for every input or runtime.

The tail implementation remains unchanged. Sharing only the two-line prefix
scan would retain the local suffix boundary rule while adding another package
boundary inside the same middle operation. That operation remains unchanged.
The single-line helper already uses standard string slicing and retains the
Native display marker. This assessment does not establish the necessity of
the other SDK sources.

## Read path normalization compatibility

Commit `86bb0a4` cached NFD for both callers. The original Native entries cache
it once; the original durable resolver computes it twice before any existence
probe. Instrumenting the original package under Bun and Node confirms that an
error from the second call propagates before probing. The shared version
incorrectly skipped that call and error.

The generator now keeps Native reuse by default, while the durable resolver
requests recomputation. Two regression tests first failed on the cached
version and then passed. Five tests and 13 assertions cover lazy evaluation,
Native sync and async reuse, durable call order and original error identity.
The 24 original durable path results and probe sequences still match.

Eight explicit strict type roots resolve 440 files without diagnostics.
All 30 patch files apply cleanly; the other 28 diffs remain unchanged.
The new patch SHA-256 is
`ee13f36ae265d1def92c02d30c8af75561f36a153e736c88651e186cbf3fb541`.
A fresh independent cache uses 99 original local packages. The offline frozen
install disables lifecycle scripts. All 30 patched files, 18 Native files and
46 runtime files match the working tree. Bun and Node each pass the same 923
test bodies and 1895 assertions. Both locks remain unchanged.

Review stayed in the main thread. Complete SDK, product, root installation
and release checks remain outside this evidence. F1/F3 remain open.

## Shared Native head truncation

Native head truncation, line counting, size formatting and default limits now
use the durable implementations exported through `/tools`. The adapter retains
Native limit getter order, invalid input errors and truncation labels. For
`a\n` with a one-byte limit, Native still reports line truncation while durable
reports byte truncation. The four tail, middle, line and UTF-8 suffix function
bodies retain their exact original text. The durable truncation JavaScript
changes only by exporting the existing line counter. Its algorithms retain
their original text.

Before replacement, the original Native entry supplied 875 recorded cases
under Bun and Node. After replacement, both runtimes match all original values,
error names, messages and codes. Another 200 JavaScript input cases per runtime
match the original entry, including Buffer and typed-array inputs, null options,
limit getters, getter failures and getter order. The source SHA-256 for this
reference is
`8e4507c3ed7ca7548cf7c2d7f77d07f2ae63a38b756789cbb44e9062db6c8762`.

The first Node comparison failed against the Bun-only baseline. Raw probes
confirmed an existing Buffer difference: the same unpaired surrogate sequence
has byte length 5 under Bun and 7 under Node. Native and durable agree within
each runtime. All 38 differing cases contain these surrogates. The fixture keeps
the separately captured original Node digests; it does not change the expected
Bun values. These checks preserve each runtime's existing behavior.

Five explicit strict type roots resolve 434 source files without diagnostics.
The converter rejects seven changed declaration boundaries. Its single-file
source check reports `sourceFiles: 1` and `complete: false`.

All 30 patch files apply cleanly and match the installed files. The previous
26 diffs outside the tools index files remain byte for byte unchanged. The patch
SHA-256 is
`33f837052d72fcd237e2d6cb3f7fd2a9c5e5c649a7adf4a13efca0f4faca1215`.
A fresh independent cache links 99 original local packages. The offline frozen
install disables lifecycle scripts and matches 30 patched files, 17 Native
source, test and package files, and 46 runtime source files. Bun and Node each
pass the same 918 test bodies. Bun reports 1882 assertions; Node runs the same
assertions through its strict assert adapter. Both locks remain unchanged.

Review stayed in the main thread. Registry tarball integrity, complete SDK and
product integration, root installation and release builds remain unverified.
F1/F3 remain open; this batch does not complete the overall architecture target.

## Shared read path candidates

Native synchronous and asynchronous read paths now use the durable candidate
generator exported through `/tools`. It owns the macOS screenshot space, NFD,
curly quote and combined spellings. The adapter retains Native lazy evaluation,
skips candidates equal to the original path and retries other duplicates.
Durable still builds the full candidate set before checking each unique path.
Native path resolution and the other four function bodies remain unchanged.

The actual Native entry passes the same 20 tests and 74 assertions before
and after replacement. They check fallback order, early success, repeated
probes, unchanged candidates and malformed file URLs. The 24 captured original
durable cases match both results and existence probes. Five isolated real
file cases match the original Native sync and async entries. These include
screenshot spaces, curly quotes, Unicode names and a missing file. The local
macOS filesystem does not establish Windows filename behavior.

Seven explicit strict type roots resolve 439 source files with no diagnostics.
The generator rejects five changed declaration boundaries. The single-file
check reports `sourceFiles: 1` and `complete: false`. The nine-file path, shell,
process, ANSI and image suite passes 166 tests and 1006 assertions.

All 28 patch files apply cleanly and match the installed files. The previous
24-file patch body remains unchanged. The patch SHA-256 is
`1f6fa31edaf5ade9e683fbcc12ca771fc53ee2fa8938687b6ca9127820c7b66b`.
A fresh independent cache links 99 original local packages and excludes the old
patched cache. The offline frozen install disables lifecycle scripts. All 28
patched files, 12 Native source, test and metadata files, and 46 runtime source
files match byte for byte. Bun and Node each pass the same 38 test bodies and
108 assertions. Node synchronizes builtin fs and spawn bindings. Both locks
remain unchanged. The first import audit used require conditions and could not
resolve the import-only pi-schema export. The corrected audit uses import
conditions and checks 46 runtime files with no nonliteral imports.

The work does not recheck registry tarball integrity, complete SDK or product
integration, root installation or release builds. Review stayed in the main
thread within the permitted files.

The first Git metadata commands in this batch did not use the isolated
environment. Git access to real HOME configuration cannot be ruled out.
No configuration content was printed. Later Git checks and the commit use
the isolated environment and system sandbox. Later passing tests do not
resolve this access gap.

## Shared Native shell algorithms

Native synchronous shell discovery still owns path searches and errors.
Its Bash argv selection and process tree cleanup now call existing durable
helpers through `compat/shell.ts`. The adapter retains the Native macOS
best-effort group `SIGSTOP` before the shared cleanup. Detached child tracking,
PowerShell and environment handling remain Native policy.

The two Bash function bodies match after TypeScript erasure. Before and after
replacement, the actual Native entry passes 18 tests and 34 assertions.
Cases cover eight WSL paths and SystemRoot variants, synchronous missing-path
errors, macOS signal order and stop failure, Unix group and child fallback,
detached tracking, and trusted Windows taskkill arguments and errors.
Signals and taskkill are intercepted by verified substitutes. These checks
do not run real Windows processes or send real kill signals.

Nine other Native functions retain their exact text. The generator rejects
seven changed declaration boundaries. The single-file check reports
`sourceFiles: 1` and `complete: false`. Ten explicit strict type roots resolve
262 source files with no diagnostics. The eight-file shell, process, ANSI and
image suite passes 146 tests and 932 assertions.

The durable JavaScript differs from the original package only by exporting
`getBashShellConfig`, `killProcessTree` and the earlier `waitForChildProcess`.
No algorithm body changes. All 24 patch files apply cleanly and match the
working tree; the previous 22-file prefix remains unchanged. The patch SHA-256 is
`45344f7300c49b46da08e092637ec61fad8bc8f40c7c3529ca63afddfbde34f0`.

A fresh cache links 99 original local packages, excluding the old patched
cache. The independent offline frozen install disables lifecycle scripts and
matches all 24 patch files and nine Native source, test and metadata files.
Bun and Node each pass the same 18 test bodies and 34 assertions. The Node
adapter uses strict assertions and synchronizes builtin spawn bindings.
Both locks remain unchanged. Registry tarball integrity, real Windows,
complete SDK and product integration, root installation and releases remain
unverified. Review stayed in the main thread within the permitted files.

## Shared child process wait

Native now forwards its child wait to the existing durable implementation
through `compat/child-process.ts`. The six-line adapter disables the durable
spill callback and selects the exit code. Native spawning still uses Node on
Unix and cross-spawn on Windows. The patch adds a public export and declaration
under `env/node`; the durable JavaScript changes only by adding `export`.
Its wait algorithm and four runtime dependencies match the unpatched package.

Before and after replacement, the actual Native entry passes 18 tests and
142 assertions. Cases cover exit and close codes, signals, both pipes ending,
quiet inherited pipes, active output on either pipe, original error identity,
stream destruction, listener cleanup and overlapping waits. Real processes
cover stdout, stderr, a missing executable, synchronous spawn and a descendant
that writes four more chunks after its parent exits. Three public durable
checks retain signal results and spill draining beyond the idle deadline.
The combined process suite passes 21 tests and 155 assertions.

The seven-file process, ANSI and image suite passes 128 tests and 898 assertions.
Five explicit roots pass strict checks with 257 source files and no diagnostics.
The generator rejects seven wait boundary changes, including body changes.
The single-file source check reports `sourceFiles: 1` and `complete: false`.
The original Native file SHA-256 is
`cd324f5b9a1abadd85ab5a331750d475c8bd51ec65cae091ad9b416245ec85d4`.

The patch now covers 24 files and applies cleanly. Its previous 22-file body is
unchanged. A fresh independent cache uses 99 existing package directories for
100 lock records. A frozen install with scripts disabled matches all 24 patched
files and all four copied Native files. Bun and Node each pass the same 21 test
bodies and 155 assertions; Node uses a small assert adapter. The consumer lock
and root lock remain unchanged. At that stage, the patch SHA-256 was
`74af1a588a0af12e3de498083c773daeced397d27f8d399cd1c42258ec2df071`.

The first consumer install could not resolve missing registry metadata in its
default isolated cache. The system sandbox blocked network attempts. The final
consumer reuses pinned lock records and a separate local cache. Registry tarball
integrity is not checked again. Windows spawning, complete SDK and product
integration, root installation and release builds remain unverified.

## Public ANSI matching

Native complete matching now uses `ansi-regex@6.2.2`, already present in the
root lock. A five-line adapter adds private CSI prefixes to the public pattern.
One replacement pass preserves adjacent escape bytes. The Native entry retains
both function bodies, its type errors and its pending window of 256 UTF-16 code units.
The new direct dependency has no transitive dependencies.

Twenty-six targeted inputs, 145 stream cuts and 3860 composed inputs match the
pinned original under Bun 1.3.14 and Node 24.22.1. Direct standard-library
replacement differs on five targeted inputs under Bun and three under Node.
The installed strip-ansi 6.0.1 differs on eight; 7.1.2 differs on three.
The TUI probe differs on twelve and evaluates only its three pure function
bodies. The public pattern plus the private CSI branch has no differences in
these cases. This sample does not prove equivalence for all possible strings.

The actual Native entry passes 30 tests and 183 assertions before and after
replacement. Its 3860 original outputs have SHA-256
`84bd631fc44a33b5273723e2889719a099ac5183361fc85d77fa31be63e6bc20`.
The five-file ANSI and image suite passes 107 tests and 743 assertions.
Four explicit roots pass strict checks with 222 source files and no diagnostics.
The ANSI and MIME source records reproduce with `sourceFiles: 2` and
`complete: false`. The generator rejects seven matcher changes. A multiline template
probe first exposes whitespace loss in generation; AST deletion then preserves
both function bodies and the template text.

An independent consumer installs offline with a frozen lock and scripts disabled.
Its four lock records come from the root lock; Bun reports six installed packages.
Twelve installed package files and three Native files match byte for byte.
The frozen lock is unchanged. Native resolves regex 6.2.2, while strip-ansi 6.0.1
resolves regex 5.0.1. Bun passes 30 tests and 183 assertions. Node executes the
same contract bodies with a small assert adapter and passes 30 checks with
183 assertions. The root lock adds one workspace dependency and one scoped
resolution; other entries remain equal.

Initial fixture checks corrected an unterminated-OSC expectation, a root-output
boundary and a hoisted-dependency assumption. The final checks resolve actual
caller paths. The cache uses twelve explicit local package files; registry
tarball integrity is not checked again. Full root installation, the complete SDK
and terminal integration remain outside these checks. The ANSI stage leaves the
durable patch unchanged from the MIME stage.

## Shared image MIME detection

The existing durable header detector is now exported through `images`.
Native forwards through `compat/image-mime.ts`, which maps an unknown result
from `undefined` to `null` and retains its 4100-byte file prefix. Eight private
header parsing helpers are removed. The original Native source matches the
pinned upstream SHA-256
`561d5511a976cdf4fc2d1b2ac773b21820bbad62e954e39c473f77c46a77f0af`.
No detector algorithm changes in the durable package.

Before replacement, 20 checks and 122 assertions pass against Native.
The shared implementation passes the same checks. Later public-export checks
bring that suite to 139 assertions. Cases cover PNG header truncation, APNG,
JPEG-LS, BMP headers and depths, unchanged bytes and subarrays. Actual files
place the APNG marker at the last eight bytes of the prefix and one byte later.
The latter file stays PNG under Native's prefix policy even though checking
its complete bytes detects animation. File errors continue to reject.

The four-file worktree image suite passes 77 checks and 560 assertions.
Twenty-one explicit roots pass strict checks with 245 source files and zero
diagnostics. The MIME source and its record reproduce with `sourceFiles: 1`
and `complete: false`; declaration checks reject signature and prefix changes.

The MIME-stage 22-file patch applies cleanly. Both the existing cache and an
independent cache install 93 packages from 94 lock records offline with a frozen
lock and no lifecycle scripts. All patched files match the worktree byte for
byte; the unchanged MIME implementation also matches. Both consumers pass
84 checks and 648 assertions across five named files, including the actual
Native MIME file entry. Native resizing and its worker remain worktree checks.
The MIME-stage patch SHA-256 is
`cfc917ca3875152c0f267de6b829d1b5c608f0e6fa8ece9b6db1424df5f6138a`.
These checks do not establish a complete root install, registry tarball
integrity, clipboard integration, terminal registration or a release build.

## Shared image encoding

Native resizing now forwards to `compat/image-resize.ts`. The durable patch
exposes its encoding and shrinking loop with a callback for the caller's
Photon runtime. Native retains Photon Node 0.3.4, sequential dimension rounding,
original-byte returns, result dimensions and the worker reply tag. Its policy
keeps the configured JPEG quality followed by 85, 70, 55 and 40, eager encoding,
the smaller initial PNG or JPEG, PNG on ties and strict `< maxBytes`. The durable
factory keeps its original inclusive limit and encoding order.

Before replacement, the Native resize core matches the pinned upstream source
byte for byte. Seventeen original outcomes are captured with image and base64
hashes and result metadata. A separate copy of the unpatched durable processor,
with only its three import paths changed, captures seventeen default outcomes.
The fixture files record both source hashes. Two checks execute the actual
Native worker module; the public resize entry also preserves caller bytes.
The final Native suite passes 21 checks and 55 assertions. The combined image
suite passes 56 checks and 414 assertions. These include encoding ownership,
eager failure cleanup, exact limits and the earlier EXIF regressions.
An added declaration check fails before the generator rejects grouped public
constants, then passes with that guard; it also checks default exports and
option changes.

Seventeen explicit roots pass strict checks with 241 source files and zero
diagnostics. The resize source and its record reproduce with `sourceFiles: 1`
and `complete: false`. The complete 22-file patch applies cleanly. Independent
and warm cache installs preserve the frozen lock and match every patched file.
Both standalone consumers pass 64 checks and 509 assertions across four named
files. They test public encoding, the default factory, EXIF and codemode;
the Native loader and worker checks run in the isolated worktree.

The encoding-stage patch SHA-256 is
`9ac4e52bff6c2849ecdc969a6321a47c8a31d7d120d8ae67f4cc9af05707febc`.
No complete root install or release build is established. Registry tarball
integrity is not checked again. Terminal registration, worker
fallback and packaged WASM layouts remain outside these checks.

## Synchronous PNG conversion

The Native converter already uses public Photon decoding and PNG encoding,
with shared EXIF handling. Its remaining core owns and frees the image.
The public TUI `ImageTranscoder` must return PNG base64 synchronously;
the provider image processor has an asynchronous interface and may choose JPEG.

A synchronous wrapper over `encodePhotonImageWithin` can force PNG by using
an unlimited size and the default PNG preference. Fourteen comparisons of
that wrapper with the actual Native `encodePng` body produce matching bytes:
thirteen valid PNG outputs and one invalid input returning null. They cover
all eight orientations and a byte subarray, and preserve input bytes.
The source SHA-256 is
`5c61e36a267b9bbd5beeb2bb3f2a0938ed7a05f7333d4a17355ea807fc7bcd3b`.
The first probe cannot call its in-memory module export under Bun; the final
probe evaluates the transpiled function body with its real image dependencies.

The wrapper adds dimension reads and a base64 round trip to the byte entry.
It removes no remaining image algorithm. The existing direct Photon call is
retained as the smaller adapter. This probe checks the encoding core only;
it does not execute the full conversion module or TUI registration.

## Shared image orientation

Native EXIF orientation now forwards to `compat/image-orientation.ts`. A small
durable patch exports its existing EXIF reader and pixel transposition helper
through `images`. The adapter retains Photon Node 0.3.4 objects, in-place flips,
new objects for transposition and caller-owned cleanup. The shared reader's
optional Native mode preserves WebP chunk bounds, short-chunk prefix checks,
signed chunk traversal and signed little-endian TIFF offsets. The durable
default remains unchanged. The encoding section above records later reuse.
Worker loading and packaged WASM policy remain in the Native adapter.

Before replacement, nine checks and 240 assertions pass against Native's
original implementation. The initial replacement passes eleven checks and
244 assertions but misses malformed metadata differences. Three added tests
fail on that implementation, then pass after the Native mode correction.
The current fourteen checks and 330 assertions pass. Fixed pixel
layouts cover all eight orientations, JPEG and three WebP layouts, both TIFF
byte orders, dimensions, input ownership, missing metadata and truncation.
They use the actual Photon Node WASM. A separate probe compares the actual old
and new entry points on 131 samples, including signed metadata and truncation
at each byte of a JPEG and a prefixed WebP. No differences remain in that set.
This does not prove equivalence for all malformed inputs. Legacy signed chunk
traversal can fail to terminate on cyclic offsets; that behavior is retained.
These checks do not establish the full image pipeline, worker fallback or
packaged application behavior.

At the orientation stage, five roots, including one durable declaration, pass strict checks
with 226 source files and zero diagnostics. One allowed Native source and its
record reproduce with `sourceFiles: 1` and `complete: false`. The complete
22-file patch applies cleanly and matches the installed files byte for byte.
That standalone consumer installs 93 packages from 94 existing lock records
with a frozen lock, no network and no lifecycle scripts. All 43 checks and
480 assertions pass. This uses existing cache files and does not check registry
tarball integrity again or establish a complete root installation.

The first lock refresh attempts fail because offline registry metadata is
missing. Reusing the earlier frozen lock with the existing Photon Node record
allows installation, but the warm cache initially retains the old 18-file
artifact and the new exports are missing. An independent cache applies all
22 files. Both patch bodies share their first 76271 bytes; Bun 1.3.14 uses the
same cache tag for them. Its internal hash behavior has not been verified.

The canonical patch starts with `# Content SHA-256: ...`, calculated from
the complete following body with LF line endings. Updating the patch also
requires updating this digest. The regression check fails without that header
and passes with it. The prefaced patch installs correctly with the old cache
present, preserves the frozen lock and matches all 22 files. The orientation
stage patch SHA-256 is
`6734cb5015b55157a24e7cd48e9857b5fcfa602fb7ad88a5e41f7e5c13b75775`.
This is an artifact workaround, not a verified fix to Bun itself.

## Public ZIP helpers

The Native ZIP writer forwards to `compat/archive.ts`. `fflate@0.8.2` owns ZIP
records and the directory. Node zlib retains raw DEFLATE and CRC. The public
`ZipInputFile` interface preserves ordered duplicate entries without keeping
one deflate window per entry. The installer awaits `JSZip@3.10.1` for ZIP
reading and CRC validation. Its adapter requires an empty directory and
checks the paths and file types of retained entries before writing files.

Focused checks pass 18 tests and 63 assertions. Python's standard ZIP reader
checks content, CRC, Unicode, binary views, duplicate names, empty entries
and all 65535 classic entries. Overflow, callback errors and write errors
are covered. No multi-gigabyte payload was allocated.

The installer checks execute the original single source file after
transpilation, with explicit platform, command, config and HTTP hosts.
They run real extraction, binary discovery, rename and cleanup for fd and
ripgrep. Independent DEFLATE fixtures check duplicate names, normalized paths,
explicit directories and Unicode. Installer checks retain versioned-directory,
root and recursive binary precedence. CRC refusal also leaves no installed
binary or temporary files.
These checks simulate Windows. They do not load the complete SDK, fetch
real release archives or establish actual Windows behavior.

Strict checks pass for five explicit source roots and existing library
declarations, with zero diagnostics. Two allowed generated files reproduce
with `sourceFiles: 2` and `complete: false`. The minimal consumer installs
14 packages from 15 existing lock records with network and lifecycle scripts
disabled. Its 13 archive checks pass with 32 assertions. Node v24.22.1 also
runs the actual writer and extractor successfully.

JSZip normalizes entry names and retains the last entry for each normalized
name. The adapter checks retained entries; this does not prove rejection of
every original path or file type that a later entry replaced. CRC validation
still processes all entries. Reading the complete archive and validating CRC
also uses memory beyond the compressed input. Windows filename rules,
permissions and concurrent changes to the extraction directory are not covered.

The cache was seeded from individually checked installed package files.
Registry tarball integrity was not checked again. The root lock-only
refresh and frozen check failed because registry metadata was unavailable
offline. The two workspace declarations use existing locked versions.
The minimal consumer does not establish a complete root installation.

A prior delegated repository TypeScript search omitted the denied-file
exclusion. It returned no restricted snippet, but a filesystem read cannot
be ruled out. This phase has no complete claim of compliance with the
no-read rule. Later direct inspection uses explicit paths checked with
realpath. The first installer fixture also triggered system tool version
probes because Bun built-in mocks did not replace static exports.
The final fixture starts with an isolated PATH and uses explicit hosts.
Final checks deny network access and reads of restricted source names
and known aliases at the operating system boundary.

## Native codemode executor through durable

The Native SDK entry now forwards to `compat/codemode-native.ts`; its separate
execution loop is removed. Durable owns VM execution, replay, model slots and
result publication. Host adapters keep Native IDs, live rows, discovery, the
branch store, worker admission and output policy. One hidden forwarding tool
uses actual official child tasks and the Native `ctx.executeTool` pipeline.

Focused regression passes 172 tests and 1160 assertions across 15 explicit
files with network access denied. The actual Native task entry checks
argument modification, permission denial, result hooks and the child owner
chain. Nine usage tests cover Native and official parents, frozen wrapper
spreads, persisted receipt metadata, explicit usage overrides and one ledger
charge for unchanged usage. Three override cases failed before correction.

Interrupted attempts rerun under the same live owner. Completed receipts
restore Native IDs, status and display usage after a model is removed.
Recorded preparation refusals remain refusals after a model is added.
Private registered names derive only from the public tool name. No separate
alias memo is needed, and catalog changes cannot change an old target. These checks do not
establish process crash recovery or exactly-once external effects.

The real branch journal runs seven cases with each executor, including the
new Native SDK entry. They cover raw writes, branch selection, absent append
support, result reuse, script failure, callback refusal and a storage failure
after append. A storage failure closes the Harness; neither the Native entry
nor `run.result` is published.

The earlier codemode patch applies cleanly to all 18 target files. A new standalone
consumer installs with lifecycle scripts disabled, network access denied and
an unchanged frozen lock. Its 29 tests and 150 assertions pass. Patch SHA-256:
`2f95b3d45069ca1cdc5faa5ce204b3ac12a60d5b6647715860c4e579579a1d46`.
Scoped strict checks cover the actual adapters, forwarding module, Native
receipt codec and public consumer. The selected execution source reproduces
with one file and `complete: false`.

Independent static review found receipt restoration, registry validation
during replay, alias drift and default alias discovery defects. The main
thread reproduced and corrected them. The actual Native entry also exposed
the non-JSON usage marker; it is now receipt metadata, restored at the SDK
result boundary. Full AgentSession, unmodified plugin loading, worker builds,
product checks and full source reproduction remain restricted. Native parent
tools keep their existing unsafe replay policy.

Final independent review found three more defects. All three failed in
real-task regression before correction: observer errors lost during lease
cleanup, concurrent forwarding registrations ignoring the durable memo winner,
and empty errors exposing private tool names. Error conversion now also
preserves text for schema errors without a structured value. Five projection
cases use expectations from upstream `toScriptValue`, independently of the
new adapter. Native and public checks pass after correction.

The sections below retain checks at their stated historical baselines.
Statements about an unwired Native executor describe those earlier stages.

## Native tool API scopes after 5fee19e

Native execution can capture the actual host API from either a CodingToolTask
or an official ToolTask. The official path retains its own task identity and
does not invent a CodingToolTask invocation. Its commit view restores the
native phase and prepares the journal before and after the callback.

The first detached official commit reached its callback but lost the native
API scope; the new case failed before the commit view was added. Normal
submission and rollback followed by a fresh commit now pass. The tests check
that neither native entry nor host document is published on rejection,
pending native operations commit once on retry, and the parent API is restored
after its official child returns. These are explicit retries in one phase,
not a guarantee of arbitrary callback replay.

Independent review found three additional gaps: a same-owner wrapper API was
not bound, the model getter was captured too early, and official tools did not
flush native appends made without an explicit commit. Each regression failed
before its correction. The wrapper identity, changing model view and final
native flush now pass through real official ToolTasks.

The journal transaction file passes 14 tests and 108 assertions. Four related
host built-in, bridge, tool task and store files separately pass 45 tests and
379 assertions. A strict public consumer checks the two scope helpers and the
API-view expression, with source equality checked separately. This is not a
full engine or SDK type check. Native codemode entry-point migration remains
in progress.

## Shared model preparation and codemode policies after 5fee19e

The SDK now calls `prepareCodemodeModelCall` for classifier and image helpers.
The shared code resolves provider/id through the host registry, validates the
context before an effect, and retains structured values and usage. The SDK
keeps its documentation hints, receiver binding, live rows and four-call
limit. Its existing sandbox execution loop still runs.

The dependency patch also adds issued-call observation, complete result
projection and an explicit cancellation-result policy. Observation runs
before admission and model-slot waiting. Projection runs after lease release.
Completed calls reuse the stored projection. Caller cancellation after VM
start returns partial output without publishing a result or store writes.
Ordinary observer, projection, release and store errors still propagate.

Independent review found that cancellation during asynchronous projection
reached the final commit and threw. The new case failed before the fix.
Completion now checks cancellation after projection, returns the existing
projection as an error and skips publication. Projection runs once. Two
companion cases retain the original projection error and default throw policy.

| Check | Result and scope |
| --- | --- |
| Combined regression | Ten explicit files pass 116 tests and 833 assertions across native journal transactions, tool ownership, bridges, store policies, output and shared models. |
| Public policies | 21 tests and 102 assertions through Harness, QuickJS and official ToolTasks. Cases include queued model rows, observer throws of `undefined`, `null` and `0`, partial cancellation output and refusal of store writeback. |
| Shared model preparation | Three tests and 21 assertions check host model resolution, deferred effects, structured image errors, usage and validation hints. |
| Native definition entry | Four tests and 50 assertions use the real tool definition with session and model substitutes. Six rows appear before slot admission, providers run at most four at a time, prompts stay out of previews, and concurrent model registries remain separate. These checks do not use a complete AgentSession. |
| Public types | Both public test roots pass strict checks. The extracted native model adapter also passes with its selected declarations checked against the source. The compiler rejects coding runtime files. These are not full SDK checks. |
| Scoped reproduction | The selected codemode execution source and its source record reproduce with `complete: false`. The generator now includes shared model preparation. |
| Patch and frozen install | The complete patch applies to a clean 1.5.0 cache. A fresh offline install with scripts disabled and a frozen lock keeps the lock unchanged. All 18 target files match. The installed consumer passes 24 tests and 123 assertions. Patch SHA-256: `a5cdc6673074941da76f8c529a3bebc190bc50c18f66e9f07e71fd8765a2a7a5`. |
| Independent review | Static review confirmed the three scope corrections and found the projection cancellation window. The main thread reproduced and corrected that window; the reviewer did not run tests. |

An earlier frozen consumer preceded restoration of two `async` model execute
methods and is superseded by the install above. Native core migration, plugin
hooks, ordinary child-tool usage accounting and restart recovery remain open.
Repeated host flushes can still call the optional commit-state hook more than
once. External callback side effects are outside the transaction guarantees.

## Codemode host policies after 05710bf

The local dependency patch adds four host integration points to durable's
codemode: a branch store adapter, an asynchronous sandbox lease, output policy
and named discovery overrides. These are local compatibility APIs. The native
SDK executor has not yet switched to them.

The store adapter reads inside the first `run.start` transaction and writes
the raw set/delete operations with `run.result`. Completed calls reuse their
result. Failed scripts do not write the store. An adapter disables the default
conversation store. The native journal fixture confirms that its entry and the
durable result appear in the same publication.

The sandbox provider receives the saved absolute deadline and task context.
Cancellation and deadline checks run again after admission. The lease is
released before formatting, including on script failure, and on startup or
cancellation failure. A completed result does not acquire another lease.
Output options keep the script token budget while allowing a host writer,
image labels, elapsed-time callback and no extra byte or line ceiling.
Custom discovery globals use the existing durable global journal.

| Check | Result and scope |
| --- | --- |
| Focused regression | Eight explicit files pass 95 tests and 676 assertions. They include the journal, host bridge, tool task, native store fixture, public policies and formatter cases. |
| Native journal fixture | Six tests pass 36 assertions using real model calls, Harness, MemoryStorage, QuickJS and the native journal. They cover branch selection, unchanged set values, missing-key deletion, no append support, result reuse, script failure and refused writeback. |
| Public policies | Nine tests pass 41 assertions through the public factory and real ToolTask. The Harness clock checks admission against the saved deadline. Real task cancellation checks a late lease without starting a VM. Output cases check 1,100,000 characters and images without an environment. |
| Public types | The policy test is a strict single-root public consumer. Its compiler host rejects coding runtime source and the restricted filename before reading. |
| Patch replay and install | The complete standard Git diff applies to the clean 1.5.0 cache. A fresh independent consumer installs offline with lifecycle scripts disabled; a second fresh consumer uses its frozen lockfile. All 16 target files match the tested package. The installed package also passes the nine public policy tests and 41 assertions. This is not a workspace frozen install. |
| Static review | An independent reviewer read the integration diff and all three relevant test files. It found no high-confidence defect and did not run tests. The main thread later corrected one test's invalid store method and reran it through the frozen-install consumer. |

The initial store refusal test called `store.save`, which the real VM rejected
before writeback. The documented `store(key, value)` and `load(key)` calls now
reach the adapter, check its raw writes and confirm the intended rejection.

Native entry-point wiring, live string call IDs, plugin hooks, model
concurrency and usage, queue policy and full restart recovery remain open.
These checks do not prove exactly-once execution of arbitrary external
callbacks on transaction retries. Full SDK and product checks remain
restricted.

## Journal transactions after 266bdb7

The native journal can prepare more than once in one durable transaction.
It uses the draft nonce to find the prefix already prepared by the same
stage. A second flush prepares only new operations; an empty suffix does
not change the revision or navigation identity. A rolled-back draft loses
its nonce, so a fresh transaction prepares all pending operations again.
Replacement still rejects a revision from a different committed stage.

Host commits restore the captured invocation around the callback and flush
again after it returns. Native appends made by a detached callback now enter
the transaction with the host document. The captured scope also supports
synchronous and asynchronous appends before an explicit flush.

Nine tests use the real journal, Harness, MemoryStorage and tool binding.
The first journal run had five failures; both detached invocation cases also
failed before their fix. All nine now pass. Together with the original
journal, host bridge and coding tool task tests, four explicit files pass
66 tests and 542 assertions. They cover navigation revisions, replacement,
branch parents, edits, compaction references, callback rollback and retry,
receipt visibility, appends while a receipt is paused, reopen and detached
appends. Independent static review found no definite defect in the three
production changes and nine tests. It did not run tests or find a production
assignment for the optional commit-state hook within the permitted paths.
The paused-receipt append case was extended in the main thread afterward.
These checks do not make
arbitrary callback side effects transactional or complete the codemode
store adapter. Full SDK and product checks remain restricted.

## Shared codemode output after 618ceae

The SDK now calls durable's `formatCodemodeResult`. Its executor has 191 fewer
lines and retains the native file writer and image-size display policy. The
local patch exports the existing formatter, its options and default token
budget. `limits: false` keeps the token budget without the extra byte and line
ceiling. The optional size callback preserves native image labels. A wall-time
callback includes file writes in the native elapsed time. Built-in callers
keep their existing defaults.

| Check | Result and scope |
| --- | --- |
| Combined regression | 25 explicit files, 210 passes, 1162 assertions and no failures. This includes the eight output cases and six real sandbox comparisons. |
| Original formatter | 96 scenarios and 97 assertions pass against 11 unchanged declarations and the original completion selected from `618ceae`. The comparison checks content and complete spill text across four token budgets, images, Unicode, many lines and partial failures. Only generated paths and elapsed time are normalized. |
| Public types | The output tests pass as a strict single-root consumer of the public types. The compiler rejects every local coding runtime source and restricted filename before reading. |
| Scoped reproduction | Search, codemode output, sleep and cancellation reproduce together with four source files and `complete: false`. |
| Patch replay | All 14 files of the complete patch apply to the unmodified cached package and match the isolated installation exactly. |
| Fresh frozen install | An independent package consumer installs offline with lifecycle scripts disabled. A second fresh install uses its frozen lockfile; all 14 patched files match the tested package. This checks the package patch, not the complete workspace install. |
| Independent review | Static review covered the wiring, exports, formatter patch and AST port, with no definite defect found. The reviewer could not obtain the historical Git diff; the original comparison ran in the main thread. |

The first install probe retained the old generation patch but omitted the new
search and output sections. Regenerating the complete patch as a canonical Git
diff fixed the installed result. Git replay alone had not exposed this gap.

This completes output sharing. The native executor still owns script
execution, model helpers, discovery and the branch store. The next adapter
must commit native store entries with the durable result, keep live string
call IDs and preserve cancellation output. Full execution replacement and the
restricted checks below remain open.

## Search core and sleep follow-up after 5702c34

The stopping condition is the lowest maintenance cost that preserves the
existing product and plugin contracts. A completed batch, passing tests or a
local commit does not close the remaining source audit and codemode work.

The SDK now shares durable's tokenizer, BM25 calculation and schema metadata
traversal. The existing local durable patch adds three compatibility exports:
`rankToolSearchDocuments`, `tokenizeToolSearch` and `createToolSearchText`.
The scored ranker accepts the SDK's configurable `k1/b`. Durable's own
`rankDocuments` delegates to it with the original defaults and returns names.
The SDK retains namespace text, its TypeBox registration and native active-tool
callbacks. These callbacks keep tool changes with the native session owner;
the new unit test reaches the callback, without testing full branch recovery.
The local exports require patch replay and compatibility checks on upgrades.

The sleep helper now delegates to public `pi-ai/utils/sleep`. The wrapper keeps
the optional signal, the coding cancellation error and ordinary timer errors.
The public implementation owns timer cancellation and listener cleanup.

| Check | Result and scope |
| --- | --- |
| Isolated regression | 23 explicit files, 196 passes, 1106 assertions and no failures. This extends the 21-file suite below with the sleep and search tests. Pre-cancelled and active waits preserve the coding error even when the reason is `NaN`. |
| Original search cases | The pinned original tokenizer and ranker sections pass all 27 cases, including multilingual queries, schema properties, namespace matches and exact names. Only the test framework and target import changed. |
| Differential search | 3256 assertions compare the new implementation with the unchanged coding and durable implementations, including configurable scores, empty corpora, unusual limits and Unicode. The temporary reference was captured before replacement. |
| Consumer types | A strict, single-root public search and optional-sleep consumer passes. Its reader rejects restricted names and any other local coding source before reading. |
| Scoped reproduction | Search, sleep and cancellation reproduce together with three source files and `complete: false`. The complete runtime closure was not traversed. |
| Durable patch | The complete patch applies to the cached unmodified 1.5.0 package. All ten patched files reproduce the installed files exactly. This is separate from a frozen dependency install. |

Codemode replacement remains in progress. Six real Harness and sandbox
comparisons passed with 38 assertions. They confirm differences in call IDs,
namespace aliases, discovery-global registration, output budgets, image
storage without an environment and branch store lifetime. For a
`max_output_tokens` value of 400000, a 1.1-million-character result stays
complete in the native implementation and is cut by the built-in formatter,
even with a larger outer output limit. These checks establish compatibility
gaps; they do not establish a completed adapter, native hook coverage or
recovery behavior.

The full SDK/source necessity audit, complete SDK and product checks, and full
source reproduction retain the restrictions listed below. They remain open.

## Durable built-ins follow-up after 13abdc2

The production host already installs durable's `codemode`, `tool-search`,
`tools` and `images` modules. `tools/codemode.ts` creates the durable extension
with the public pi-codemode sandbox. `CodingHost` converts registry tools through
`hostToolToAgent` and injects them through `baseToolsOverride`. This assembly was
confirmed by static inspection; the complete product entry point was not run.

A real QuickJS Worker test then exposed a bridge failure: Worker callbacks did
not retain the async context required by the Agent's commit function. The
captured failures were `Agent commit outside a durable task phase`.
`currentCodingToolInvocation()` now captures the current async context and
restores it for later flushes. Durable still owns the codemode implementation,
its journal and its official nested ToolTasks. The other two engine commit
bindings execute within `withPhase`; official host reentry creates its own
phase. The search of these bridge and engine sites found no second unbound
flush callback.

The new `host-builtins.test.ts` uses the real Agent, Harness, production
codemode factory, sandbox Worker and approval wrapper. It verifies an approved
child call and its official task owner, rejects a model-only target from a
script, and passes tool-search activation to the owning coding run. The
denial check also requires the target's name in the result and no bridge
exception, so an unrelated execution failure cannot satisfy it.
This test does not instantiate the complete AgentSession or validate its
tool-declaration updates, branches, reopen or restart behavior.

The cancellation helper now uses the public `pi-ai/utils/abort` module.
`operationSignal` forwards directly. `raceWithAbortSignal` retains only the old
optional-signal behavior, including the original Promise object when no signal
is supplied. Six tests cover identity, abort reasons, listener cleanup and
observation of an abandoned rejection. The generator checks export names,
export count and parameter count before producing this wrapper. That guard
does not establish type or behavioral compatibility with a future version.

| Check | Result and scope |
| --- | --- |
| Final isolated regression | 21 explicit files, 186 passes, 1082 assertions and no failures. This is the 19-file shared implementation suite below plus `shared-abort.test.ts` and `host-builtins.test.ts`. |
| Real built-ins | Three tests and 22 assertions pass. The Worker commit failure was observed before the scope fix; both codemode scenarios then pass without bridge exceptions. Tool-search coverage ends at the activation callback. |
| Cancellation types | A strict, single-root consumer check passes for the public cancellation API and optional-signal wrapper. This is not a full SDK check. |
| Scoped reproduction | `vendor-coding-runtime.ts --check --file=utils/abort.ts` passes with one source file and `complete: false`; it does not traverse the runtime closure. |
| Source registration | The cancellation source, generator, runtime manifest, cancellation test, engine and built-ins test have local registry entries. This does not replace the full Craft audit. |
| Independent review | Separate static reviews of the cancellation change and the Worker scope fix found no confirmed actionable defect. Neither reviewer ran tests. The second review does not establish runtime coverage of multi-Agent Worker concurrency, journal writes or late callbacks. |
| Blocked checks | Full runtime generation, full Craft audit, full SDK/repository type checks, complete coding/product suites and worker/server builds remain unrun because they can reach restricted source. No new cross-platform or packaged product result is claimed. |

The SDK's native codemode and tool-search extensions still expose factory,
session-entry, rendering and tool-activation contracts. The native search
ranker also accepts namespace text. Mapping these contracts onto the durable
modules needs further work; different API shapes alone do not justify keeping
the copies. Their replacement and the full source-necessity audit remain open.

## Shared implementation follow-up at 13abdc2

The changes after `f2b90d5` share package management, message conversion,
model facades, settings merge, session storage, extension execution, token
estimates and resource algorithms. Seven authored policies in `src/legacy/`
retain host behavior. Generated legacy paths forward to those policies;
the generator does not keep a second copy of their bodies.

The helper inventory has six selected source ports, six unchanged fixtures
and 28 shared entries. Eighteen entries are direct forwards; ten retain
external policy. This is reuse of the ported implementation, separate from
the public package imports recorded below.

Against `f2b90d5`, the 23 affected production source files add 342 lines and
remove 6379, a net reduction of 6037 lines including the new adapters and shared types.
Tests and port rules are counted separately. The runtime inventory still has
248 source files and nine assets; their complete necessity is unverified.

| Check | Result and scope |
| --- | --- |
| Isolated regression | 19 explicit test files, 177 passes, 1046 assertions and no failures in one final command after the type corrections. Covers shared policies, official plugins, resources, native models and input, durable execution, boundaries, tool ownership, approval, cancellation, storage and session projection. |
| Consumer types and declarations | A strict source consumer and declaration emit pass for the actual package and session-view callers, host message metadata, open settings and token inputs. The regression is kept in `test/shared-compat-types.test.ts`. Its file reader rejects restricted source and real-path aliases before reading. This is not a full SDK check. |
| Helper reproduction | `vendor-upstream.ts --check` passes with 12 source products and 28 shared entries. Six products are unchanged official fixtures. |
| Scoped runtime reproduction | Seven explicitly permitted source/output records reproduce: package-manager, messages, resource-loader, footer-data-provider, settings-manager, session-manager and extensions/runner. `--check --file=...` does not traverse imports or generate an inventory; its result states `complete: false`. Nine negative cases cover invalid mode, empty or escaping paths and restricted-name case variants. |
| Source registration | The 37 changed coding source, script, test and manifest files have local registry entries, including 16 new entries. The complete Craft audit was not run. |
| Independent review | The reviewer completed static coverage of the original 42-file, 113-hunk diff and the final five-file, five-hunk type correction, with no confirmed actionable defect. The reviewer did not execute tests. Final document facts and registry hashes were checked by the main thread. |
| Blocked checks | Full runtime generation, full Craft audit, full SDK/repository type checks, complete coding/product suites and worker/server builds can read restricted source. They were not run. Full Runner and ModelRuntime type closure is not covered by the scoped consumer. |

The regression uses `bun test --timeout 20000` through the approved isolated
HOME/config and environment allowlist. It includes the existing
`packages/pi-durable-coding/src/resources.test.ts` and these files under
`packages/pi-durable-coding/test/` are
`{host-resources,host-project-resources,extensions,native-models,native-user-input,durable-agent,durable-runtime,durable-boundaries,durable-coding-tool-task,durable-session-store,host-tools,shared-packages,shared-models-messages,scoped-port-check,shared-sessions-runner,shared-context-tokens,session-view,shared-compat-types}.test.ts`.
No actual model endpoint, live WebUI, real credentials or full SDK entry point
was used.

Strict checking first exposed narrower JavaScript types despite passing
runtime tests: shared factories returned the native class type, and converted
messages lost their host metadata fields in the inferred return type.
Explicit legacy boundaries and class factory return annotations restore the
old contract. The persistent consumer test failed on the metadata case before
that correction and passed after it.

An all-`any` parent then reproduced TS7006 for ordinary array callbacks.
A shared type-only constructor mapping and structured projection returns keep
scalar, array and Promise inference without copying a method declaration list.
The consumer also checks branch and context callbacks, string replacement
callbacks and static list callbacks.

The token fixture initially used the wrong context-edit shape and assumed
that system content replaced earlier text. The corrected fixture follows
the public message types: `replacement.content`, section replacement and a
compaction `systemMessage`. No estimator algorithm was changed.

The architecture now records the six selected helper exceptions and the
remaining full-closure questions. F1/F3 do not claim complete necessity
verification. F4/F5 full checks and final acceptance remain open.

## Earlier architecture follow-up at f2b90d5

The document correction and independent gap review were committed as
`e3762bc` before that implementation. That change restores public core
type imports in 28 files, shares 14 helper implementations, and keeps legacy
documentation URLs in a 30-line external prompt adapter. At that revision the
helper inventory had 13 source ports, six unchanged fixtures and 21 shared entries. Eighteen
entries are plain forwards; skills, prompt templates and system prompt retain
host policy. Skills and prompt templates each need an optional project directory
parameter in the shared implementation. Legacy wrappers pass `.pi`; native
calls retain the installation default.
At that revision the runtime inventory had 248 TypeScript files and nine assets.

| Check | Current result and scope |
| --- | --- |
| Affected regression suite | 10 files, 117 tests, 661 assertions, zero failures; one combined command exited 0 after the final code change. Covers resources, unchanged official plugins, models, durable Agent, recovery, host approval, nested tools, cancellation and storage. |
| Public type imports | All 28 files produce identical Bun JavaScript before and after the change. Permitted source and output hashes match; no complete runtime reproduction is claimed. |
| Helper reproduction | The permitted generator check exits 0: 19 source products, including six fixtures, and 21 shared entries. The two directory transforms and the provider type transform also reproduce permitted pinned source exactly. |
| Declarations | Thirteen permitted helper declaration roots, the external policy and the actual native-models.ts consumer pass a targeted build. The consumer also passes a strict type check. This is not a full SDK or repository type check. |
| Product and platform scope | No worker, UI, permission, task, storage or packaging implementation changed. Earlier product and platform results retain their original scope; no new product or cross-platform run is claimed. |
| Full checks | Full runtime generation, full Craft audit, full SDK/repository type checks, complete coding/product suites and worker/server builds can reach restricted source. They were not run in this session. Unchanged lint targets retain the documented `f4f9f26` evidence; root lint was not rerun. |
| Independent review | The initial 49-file diff and the added scope up to 57 files were reviewed. Directory and provider type regressions were reproduced and corrected. A final review of the three type-correction implementation files confirmed the fix with no new actionable issue. Final registry and document updates were checked by the main thread. |

The regression command uses these files under
`packages/pi-durable-coding/`: `src/resources.test.ts` and
`test/{extensions,durable-agent,native-models,durable-runtime,durable-boundaries,durable-coding-tool-task,durable-session-store,session-view,host-tools}.test.ts`.
It runs through the task's isolated HOME/config and environment allowlist, with
`bun test` and `--timeout 20000`. The declaration build uses 13 permitted
helper roots, the external policy and the actual host consumer, with strict
checking, `allowJs`, `checkJs: false`, `noUncheckedIndexedAccess: false`,
`skipLibCheck`, and declaration output in a task-owned directory.

The new process test first failed because both legacy resource entries scanned
`.tau` instead of `.pi` when `PI_PACKAGE_DIR` selected a different installation.
It passes after the explicit directory parameter was added. It also checks that
native calls still scan `.tau` and explicit legacy paths keep project scope.
An added identity assertion initially used `source` instead of `scope`; the old
source confirmed that `source` is `local`, so the final assertion checks `scope`.
The first declaration command named three paths in the wrong directories and
failed; the command with the actual helper paths passed.

The last five shared helpers were checked before replacement. Extension runtime
helpers, the pi-ai extension view, provider composition and configuration value
resolution produced identical JavaScript. All six selected shell declarations
matched. The shell forward retains only its previous public API.

The shared provider signature initially required the complete `ModelConfig`
class. A strict check of the real `native-models.ts` consumer reproduced two
TS2345 errors at its existing structural calls. The function reads only
`getProvider`; a type-only correction to `Pick<ModelConfig, "getProvider">`
retains that contract. The consumer type check and declaration build then
passed. Bun produces identical JavaScript before and after the correction.

The source registry matches all 53 changed coding files. Thirty-one permitted
runtime source and output records match their pinned manifest hashes.
These are scoped checks; the full audit remains blocked.
Remaining source reasons and upgrade checks are recorded in the
[architecture](coding-architecture.md). F5 remains blocked; the complete task
has not passed final acceptance.

## Earlier f4f9f26 baseline
The f4f9f26 package-assembly changes use public core protocol types and
`streamProxy`, move host compaction policy outside native settings, and replace
seven duplicate helper implementations with forwards. The runtime inventory is
now 248 source files and 9 assets. The earlier helper inventory contains 27
source ports, 6 unchanged fixtures and 7 forwards. Historical counts below
remain evidence for the revision where they were measured.

Both extension loaders now receive Bun file metadata through Jiti's public
transform and Babel plugin APIs. A separate cache namespace prevents old
transforms from bypassing the adapter. The metadata regression failed before
the fix; all 8 loader and stack tests then passed with 24 assertions. Source
generation was checked for the helper layer. The runtime manifest was updated
only for permitted files; its complete generator check was not rerun because
it reads the restricted credential source.

The combined coding/worker test command reached its 300-second limit after
829 passes and no failures. Its first 73 completed files contain 820 passes;
the incomplete file and the next 10 files passed separately with 151 tests.
Together these runs cover 84 files and 971 tests without counting the 9
repeated passes. The combined command itself did not complete. The 17 pinned
behavior scenarios and the unchanged plugin reference contract also passed.
The latter recorded 28 UI effects, 4 local replies and an idle session.

Current product checks passed: 1 plugin test with 65 assertions, 1 coding and
default-profile test with 43 assertions, and 4 default conversation tests with
22 assertions. The worker build and `validate:ci` passed. Lint first stopped
because the isolated Craft reference path was missing; after setting the
existing pinned mirror it passed with 0 errors and 107 existing warnings.
Documentation punctuation and diff checks passed. The full repository test
suite was not rerun. Craft lineage entries were updated for the changed files;
the complete audit was not run because it also reads the restricted source.
The independent static review found no actionable issue but did not obtain a
complete Git diff or execute tests; the main thread reviewed the implementation
diff and ran the checks above.

## Corrections after the clarified documentation baseline

D1 changes after documentation commit `f7a33eb` separate native execution from
automatic resource discovery. The `host-only` resource policy keeps explicit
host plugins, paths and settings ports. It isolates ambient Pi settings,
extensions, skills, prompts, themes, context and system-prompt files. Normal
sessions keep their existing durable GenerationTask behavior.

The new tests first reproduced ambient extension execution, then passed after
the policy change. A production-host test invokes the unmodified upstream
hello plugin, applies approved arguments and restores its tool history after
reopen. Coding/server regression: 771 passed, 0 failed across 53 files.
`validate:ci`, the isolated Craft audit and the pinned-source generator check
passed. Lint passed with 0 errors and 106 warnings. The source inventory remains
249 files and 9 assets. These results cover D1; whole-product and remaining
plugin integration acceptance stay open.

## Implemented scope

The coding profile uses the existing `DurableKernel` and its Harness.
`@mkagent/pi-durable-coding` contains the complete public Pi coding source
closure from v1.5.0, commit `f9a26365568127461c47a07a37dcb42c140a3ac5`.
`UPSTREAM-RUNTIME.json` records 248 source files, 9 assets, source hashes and
controlled transformations. `UPSTREAM.json` records the earlier compatibility
helpers. The package retains the upstream MIT license.

Production constructs the native `AgentSession`, `DefaultResourceLoader`,
`SettingsManager` and bound `ModelRuntime`. A local Agent facade delegates
execution to `pi.coding.session`, `pi.coding.run` and owned tool tasks in
pi-durable. The old Agent loop is not copied. Native retry, compaction and
settlement callbacks return to durable phases.

The journal commits native messages, branches, context edits and the next task
checkpoint together. Steering, follow-up and custom input acceptance have
separate durable receipts. Queue cancellation survives restart. Entry observers
publish host anchors only after storage acknowledges the receipt.

Request intent is recorded before context transforms, provider callbacks and
stream events. Recovery reports an interrupted operation instead of repeating
callbacks with uncertain effects. Uncertain tools repeat only when their
registration explicitly sets `replay: "safe"`. Effects outside durable storage
do not have an exactly-once guarantee.

Startup fences supported legacy `pi.generation` v4 and owned `pi.tool` v3 work
before opening the new Harness. One transaction transfers the successor root,
accepted queues and original submission IDs. A rejected transaction restores
the live session snapshot. A failed root or interrupted finalizer settles placed
inputs as unanswered. A successful answer must follow its input in the current
native branch.

The host permission wrapper owns tool approval. Native `tool_call` handlers run
before approval. `tool_result` receives the final approved arguments. Nested
calls use a durable task owner. Native tool metadata and discovery remain
available after catalog replacement and restart.

Tool handoffs reset the native branch in the same durable commit as the next
checkpoint. The last handoff in tool-call order wins, including an empty
summary. Accepted steering follows that summary. Recovery retains the new
context without repeating the completed tool.

The server bundle includes separate Photon WASM files for the durable and
native coding tools, native themes, HTML export templates and the Pi MIT
license. Headless archives also include the root LICENSE and NOTICE. Image
workers resolve from the installed module; the project directory cannot
supply an executable worker.

The current production dependency graph uses the public `pi-agent-core`
protocol and proxy APIs. The dependency policy prohibits the complete
`pi-coding-agent` package and keeps execution within the durable boundary.
The `./native`, `./agent` and `./durable` exports expose the native coding layer,
durable Agent facade and host bindings. Declaration files come from the same
sources. The shared transport retains its existing wire contract.

## Verification

Checks use temporary HOME and config directories, an environment allowlist,
local deterministic models and random loopback ports. They do not use the live
WebUI, real credentials or the real Craft checkout.

| Check | Evidence |
| --- | --- |
| Full coding and production host regression | 769 passed, 0 failed across 53 files |
| Native lifecycle recovery | Actual SIGKILL and restart, uncertain requests and callbacks |
| Production migration and queues | SQLite and JSONL SIGKILL checks, original IDs and repeated text |
| Legacy checkpoint adoption | 12 startup cases across both storage backends |
| Adoption rollback | Admission and commit rejection, followed by concurrent retry |
| Upstream behavior oracle | 17 scenarios in separate upstream and local processes |
| Type checks | Coding declarations, server and repository consumers |
| Repository checks | `validate:ci`, lint and isolated Craft source audit |
| Source reproduction | Pinned source hashes and controlled port comparison |
| Source integrity | Dirty upstream source directory rejected before generation |
| Clean installation and build | Frozen lockfile with scripts disabled; clean declarations and server bundle passed |
| Independent package consumer | Runtime and declaration imports passed for root, compat, native, agent and durable |
| Handoff recovery | Reversed parallel completion, empty summary, steering, reopen and SQLite/JSONL SIGKILL |
| Bundle resources | Project worker canary blocked; relocated PNG processing, BMP read and HTML export passed |
| Headless archive | macOS arm64 build, license/assets inspection, launcher, HTTP health and authenticated WebSocket passed |

`validate:ci` passed after a test fixture type error was corrected. Lint
finished with 0 errors and 106 warnings. The isolated Craft audit passed.
After the final asset-path correction, all five affected bundle checks passed.

The oracle covers text, loadout changes, tool round trips, message transforms,
parallel completion order, sequential batches, aborted preflight, queued inputs,
turn and settlement continuation, nested settled actions and terminating tools.
Its upstream npm installation is an independent behavior reference. The pinned
git checkout supplies the source hashes; npm bytes alone do not prove git identity.

The standalone subprocess fixture loads an unchanged official `hello`
extension, applies host approval changes, executes its tool and sends the result
in the next request. JSONL and bundle checks run outside the source tree.

Host regressions also cover extension providers and virtual models through
reload and reopen, auth availability after catalog replacement, dynamic tools,
deferred discovery, nested calls, model usage and context occupancy. Native
compaction reads effective profile and project settings. The host window
override stays in memory and follows model changes.

The request recovery checks first reproduced repeated callback effects.
Adoption failure checks first reproduced live queue mutation after rollback.
Production crash checks first reproduced an old answer settling a new input,
and an interrupted finalizer leaving an input permanently placed. Each has a
test in the repository that passed after its correction.

## Historical capability record before visual acceptance

This section combines the original `4776fe1` record with later corrections.
It is not a snapshot of that commit. PowerShell wiring was added in `57bbaf5`,
successful-read prerequisites in `61fac5d`, and search, long-output and mixed
instruction checks in `a41e6b5`. Statements about missing real PowerShell,
browser, Desktop and terminal checks describe that earlier validation period.
Later selected checks have passed; use the
[acceptance crosswalk](coding-acceptance.md) and the implementation plan's macOS,
WebUI trust and Desktop package records for current evidence. Their coverage
limits still apply.

Retaining native source does not establish all host and platform combinations.
The table records historical evidence and gaps. It does not waive the target.
The [acceptance crosswalk](coding-acceptance.md) tracks every specification row
and MkAgent retention area during D6. It separates pending behavior checks from
environment blocks.

| Inventory area | Behavior and limits |
| --- | --- |
| read/write/edit/bash | Production tools keep host approval. Native implementations and public SDK exports are retained. Filesystem, approval and timeout regressions use local fixtures. |
| grep/find/ls | Host tools keep their cancellation adaptations. Actual macOS rg/fd/ls checks cover Unicode, hidden files, ignore rules, limits and failures. Other platforms remain open. |
| Images and long output | Relocated native PNG processing and durable BMP reads use their respective packaged WASM files. A real coding host checks a complete UTF-8 spill, tail window and reads after durable reopen. |
| PowerShell | `57bbaf5` exposes a deferred named tool for explicit activation. Host Ask mode requires each approval; Explore blocks it. A real worker uses a local process fixture to check wiring and arguments. Real PowerShell was not prepared for that check; later macOS results are recorded separately, and Windows remains unverified. |
| Permissions and metadata | Allow, deny, modified arguments, nested calls, visibility and durable ownership have coverage. Trusted Node plugins are not sandboxed. |
| Project instructions | Native parsing and source identity are retained. Project execution requires host trust. Mixed host path discovery and native global/ancestor/cwd content reach model requests after reload and context hooks without duplicate content injection. Separate files retain their source paths even when their text is equal. |
| SYSTEM/APPEND files | Native precedence and composition have coverage. The host base prompt remains present. |
| Native skills | Native parsing, explicit invocation, collisions and installed resources have coverage. |
| Skill activation | Native expansion and shared mention discovery are retained. `61fac5d` clears Read/Bash prerequisites only after approved foreground completion. Real default and coding workers cover failed, denied, masked-failure and successful reads, including stdin versus fd 3 redirection. Bounded skill fallback remains; strict browser prerequisites do not fall back. |
| Prompt templates | Native parsing, quoting, defaults, slices, collisions and input transforms have coverage. |
| Extensions: tools | Unmodified plugins, structured results, nested calls, progress, cancellation and deferred discovery have coverage. |
| Extensions: commands/input | Native command and input processing are used. Production reload and handled-input cases have coverage. |
| Extensions: events | Native run, turn, message, tool and settlement events are retained. Oracle scenarios check order and effects. Crash tests check uncertain delivery. |
| Extensions: context | Native transforms, boundary drafts and journal projection are used. Complex mixed provenance combinations are not all exercised. |
| Extensions: state | Custom entries, labels, IDs, committed restore, edits and forks have coverage. |
| Extensions: models | Host models, extension providers, virtual models, selection, reload, reopen and auth availability have coverage. Native `/login` and `/logout` support interactive OAuth and API keys through the active model runtime. Tests cover native and compatibility providers, secret prompts and cancellation. |
| Extensions: session control | Native APIs are retained. Production managed operations use host bindings. Every navigation, fork and concurrent close combination is not exercised. |
| Extensions: UI | Native RPC dialogs, notifications, widgets and cancellation have production coverage. Terminal components require a TUI host. Browser acceptance remains pending. |
| Local package resources | Native installed-manifest discovery, filters and diagnostics are used. |
| npm/git package management | Native coding sessions expose `/packages` for explicit list, install, remove and update. User scope is the default; `--local` selects a trusted project. Tests cover npm/git, reload, write failures, protocol output and shutdown draining. Operations are not atomic or replayed after a crash. `host-only` omits this command. Discovery still skips missing sources. |
| Project MCP | Native and host project configurations share explicit host trust, including revocation on reload. The product approval path has coverage. |
| Native MCP registrations | Plugin registrations update host connections and durable tools at startup, change and reload. Tests cover namespace priority, failure recovery, immediate tool and resource revocation, and removal during login. |
| MCP provider credentials | Global configuration and trusted plugins read current provider tokens through host models or the bound native model registry. Product tests cover startup, rotation, unregister, re-register, reload and interactive provider login. Login reconnects dependent MCP services; logout withdraws their tools. Project configuration cannot select host providers. |
| MCP OAuth | Coding mode provides explicit status, login, logout and reconnect through native RPC. Tests cover PKCE, redirect validation, scope escalation without tool replay, token rotation, TLS admission and two-process login or cancellation. Real worker checks cover re-init, owner release, shutdown and late replies. Browser acceptance remains pending. |
| Codemode/tool search | Official host integrations and native tools share durable execution. Dynamic catalogs, deferred activation and handoff context through restart have coverage. |
| Retry/steer/follow-up/compaction | Native callbacks use durable phases. Accepted queues, cancellation, repeated text, retry deadlines and compaction thresholds have coverage. |
| Resume/branch/usage/export | Journal and legacy projection tests cover history, edits, branches, forks and usage. Native HTML export works with relocated templates and themes. All combinations of multiple heads and managed navigation are not exercised. |
| CLI/JSONL/Desktop/WebUI | Packaged subprocess and JSONL checks run locally. The macOS arm64 headless launcher, health endpoint and authenticated WebSocket were exercised. Real Desktop and browser interaction were not exercised. |
| Themes/shortcuts/editor/renderers | Native sources and resources are retained and packaged. Interactive terminal behavior was not exercised. |

The coding profile or explicit coding resources select the native
`AgentSession`. Both profiles execute through pi-durable. Normal sessions use
the durable GenerationTask path and keep their Pi-resource isolation.
`resourcePolicy` controls native discovery separately from execution.

Whole-product acceptance is still open. The checks above do not cover every
MkAgent default-profile feature, product session operation or Desktop/WebUI
flow. Those paths must be exercised in isolated environments before completion
is claimed.

Unsafe legacy checkpoints, old checkpoint versions and uncertain effects fail
closed with migration diagnostics. Startup does not silently discard them.
Those stores need reconciliation with the previous runtime before migration.

After an uncertain request, accepted queues remain available. An explicit new
prompt starts before those retained queues, following native prompt semantics.
The interrupted model request is not automatically repeated. Native history
keeps the failure message; durable model context excludes failed, aborted and
deferred assistant messages.

## Reproduction and upgrade

Historical repository acceptance entry points are listed below. They do not
constitute current permission to run checks that reach restricted source.
The full coding suite, reference parity, validate:ci and worker/server builds
are blocked in this session; use the scoped checks recorded above.

```sh
bun test ./packages/pi-durable-coding ./packages/pi-agent-server
bun packages/pi-durable-coding/test/reference/parity.ts \
  <isolated-upstream-node-modules> <pinned-Pi-checkout>
bun run validate:ci
bun run lint
bun run --cwd packages/pi-agent-server build
bun install --frozen-lockfile --ignore-scripts
bun run server:build --output <task-owned-output-directory> --compress
```

The complete runtime generator check and full Craft audit are currently
blocked because they read restricted credential source. Do not run or retry
them, or read local or upstream `runtime-credentials.ts` through another tool.
Partial hash checks do not establish full reproduction.

Set `CRAFT_AGENT_SOURCE` to the isolated pinned Craft checkout. The earlier
helper port uses `scripts/vendor-upstream.ts` in the coding package. Durable
patch reproduction uses `scripts/patch-durable.ts` with the pinned checkout,
installed durable directory and pristine durable directory.

The headless build replaces its output directory. Use a new directory owned
by the validation task.

On upgrade, compare the public source closure and controlled port scripts.
Regenerate both source manifests, declaration files and the Bun patch. Run the
oracle, subprocess, journal, queue, lifecycle and stored-task migration checks.
The generator requires a clean pinned checkout for every consumed coding and
Agent source, package metadata and license.
Current checkpoint tests do not establish support for a future Pi release.
