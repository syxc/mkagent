# Pi-durable coding agent validation and remaining work

This file is an evidence record. It preserves checks at `4776fe1` and later
versions, including failed attempts and their corrections. The requirements
come from the [capability specification](coding-capabilities-spec.md); the
[implementation plan](durable-coding-agent-plan.md) and
[correction list](coding-follow-up.md) define current work. An older retention
decision, source inventory or green test run does not override those documents.

MkAgent first replaced Pi coding agent directly with pi-durable. That exposed
insufficient Coding capability and prevented reuse of the Pi plugin ecosystem.
The clarified target keeps the Pi Coding layer from MkAgent's point of view and
attempts to replace its execution base with pi-durable. Preserve the original
integration contracts, later confirmed product behavior and existing data.

The earlier source-copy approach risks source-by-source adaptation on each
Coding and durable release. Prefer durable built-ins for execution and reusable
official Pi SDK APIs for Coding behavior, then the required thin adapter.
Source ports and patches need a confirmed gap and bounded upgrade work.
Third-party resource replacement and reproducible source inventories alone do
not establish that this maintenance goal has been met.

Sections below describe their own versions. Words such as "current", "retain"
and "remaining" in older sections apply to that section's checks. They do not
make private implementation details, the full Native SDK or upstream CLI into
requirements. Report confirmed missing functionality and missing evidence
separately. Unverified combinations alone do not prove a functional defect.

## Public SDK system prompt builders after dc64ddc

The public Coding SDK supplies system prompt construction, normalization,
section validation, rendering and diff algorithms. The complete 228-line local
module is deleted. The former 30-line legacy wrapper becomes a five-line
binding, and the Native binding has six lines. Both only inject documentation
getters. Native paths come from its installation; legacy paths remain the fixed
v1.5.0 GitHub URLs. Default SDK exports retain the SDK's own paths.

Durable does not expose this Coding construction contract. The Coding patch
adds createSystemPromptBuilder and existing root exports. The factory places
the three existing builders in a documentation dependency closure. Normalization
and diff remain shared module functions. Reversing only these changes restores
the complete system-prompt JS and declaration bytes from pristine SDK 1.5.0.
No construction algorithm moves into a patch template. Equivalent public
upstream dependency injection and exports will let this patch retire.
No task, checkpoint, document or codemode module version changes.

Full generation has 68 runtime TypeScript files: 64 under src/pi and four
facades, with no assets. Auxiliary sources remain nine and shared entries 16.
Coding has 60 physical patch outputs, core four and durable 33, for 97 total.
The two additional outputs are system-prompt JS and declarations; root outputs
are shared. Runtime, auxiliary and patch checks pass. Pristine replay verifies
all original and resulting Coding hashes. Both existing layouts pass frozen
installation with scripts disabled. All 60 Coding and 33 durable outputs match
in both layouts. Dependencies and lock remain unchanged.

Checks use Bun 1.3.14 and task-owned HOME/config/cache. Declarations and server
build outputs go to task directories. No live credentials, provider requests,
product UI or product data are used.

| Check | Result and scope |
|---|---|
| SDK differential probe | 142 assertions pass across 13 inputs: all three Native, legacy and default SDK builders match their previous implementations; original module bytes, root/internal identities and shared normalization/diff also pass |
| Prompt boundaries | Empty and nonempty custom/force prompts, context files, Windows cwd, guidelines, hidden tools, skills, section validation, inherited and nonenumerable options, array cloning, multiple builders and lazy getters pass |
| Root tests | 28 tests and 220 assertion calls pass across resources, shared sessions, host extensions and the published SDK boundary |
| Hoisted plugin and recovery tests | 43 tests and 422 assertion calls pass across host resources, extension SDK, codemode, host AgentSession and Native recovery; the latter covers 18 recovery points |
| Coding types and declarations | Root typecheck and actual declaration builds in both layouts pass |
| Hoisted server | Typecheck and build pass |
| Hoisted worker bundle | 26 tests and 105 assertions pass, including relocated resources, images, dynamic tools and local model/auth fixtures |

The original 12-stage runner records 11 successful stages and one failed probe
stage. Its temporary reference module cannot resolve pi-ai from the task
directory, so it stops before differential assertions. The original failed
receipt and log remain. The probe alone is corrected to resolve pi-ai from the
Coding package and rerun in an isolated child process. All 142 assertions pass.
Successful installation, test and build stages are not repeated. Repeated
coverage in two layouts is not counted as distinct feature coverage.

The source registry updates 13 hashes, removes the complete local module and
adds the Native binding. The fixed Craft v0.15.6 audit covers 2079 files and
passes. Source hashes, patch replay and this focused test run do not establish
that all remaining source is necessary.

Independent read-only review finds no reproducible new correctness or public
contract defect relative to dc64ddc. Its separate probe passes 24 input cases
and 286 runtime assertions, including the SDK default, Native and legacy runner
plugin chains. A consumer semantic check passes 20 type-equivalence assertions
and two expected-error checks. The review also reverses the factory changes
and confirms the installed JS matches pristine bytes. Its first two probe
starts fail because of an incorrect local Bun path and require.resolve on an
import-only package; corrected probe starts pass. These are probe failures,
not repository defects. The review does not repeat installation, declaration
builds or the larger suites.

At the review's 2026-11-10 12:08 +0800 read, documentation still reports the
previous slice's 69/65 runtime counts and 58 Coding outputs. The parent thread
then updates all six documents to 68/64 and 60, keeping earlier counts as
historical evidence. All six punctuation checks, 183 local link checks, the
exact 22-path scope, current source hashes and diff checks pass.

F0 through F6, the remaining 64 src/pi files, dynamic tools, codemode adapters,
SDK internal session/shell policy, the existing AuthContext gap, Photon cleanup
on an EXIF callback failure and the existing ToolHtmlRenderer export ambiguity
remain open. This slice does not run the full repository suite, product UI,
live services, Windows/Linux or the complete product acceptance matrix.

## Public SDK skill and prompt discovery after c6227a6

The public Coding SDK now supplies skills and prompt-template discovery,
validation, diagnostics, source metadata, argument parsing and expansion.
The two complete local modules and their old directory conversion script are
deleted: three files and 849 lines. Two Native bindings total 19 lines. They
retain the Native installation directory and skills agentDir default. Legacy
skills still require agentDir before scanning; both legacy loaders use `.pi`.
The direct ignore dependency and its workspace lock declaration are removed.
The SDK's own ignore dependency and other transitive resolutions remain.

Durable does not expose these Coding discovery contracts. The Coding patch
adds an optional projectConfigDir to two load functions, replaces three directory
expressions and exports existing modules at the root. Default SDK calls still
use its own CONFIG_DIR_NAME. All other JS and declaration content in the four
module outputs matches pristine SDK 1.5.0 after reversing these parameter
changes. No discovery or expansion algorithm moves into a local patch template.
Equivalent upstream parameters and root exports will let this patch retire.
No task, checkpoint, document or codemode module version changes.

Full generation now has 69 runtime TypeScript files: 65 under src/pi and four
facades, with no assets. Auxiliary sources remain nine and shared entries 16.
Coding has 58 physical patch outputs, core four and durable 33, for 95 total.
The four additional outputs are the skills and prompt-templates JS/declarations;
root outputs are shared. Full runtime, auxiliary and patch checks pass. A
pristine replay verifies all original and resulting Coding hashes. Both existing
layouts pass frozen installation with scripts disabled, including a second
necessary installation after removing the direct dependency. All 58 Coding and
33 durable outputs match in both layouts. Lock changes are limited to the
workspace's direct ignore declaration, as checked against HEAD.

Checks use Bun 1.3.14 and task-owned HOME/config/cache. No live credentials,
provider requests or product data are used. Declarations go to task directories.

| Check | Result and scope |
|---|---|
| SDK differential probe | 41 assertions pass: four original module outputs, root/internal and binding identities, ten default differential cases, alternate directory, user/project scope and expansion |
| Root initial tests | 26 pass, seven fail; 133 assertion calls across five files. All 13 resource tests pass. Environment failures and the separate reruns are preserved below |
| Package-command rerun | Ten tests and 59 assertions pass in an isolated process with fake npm/git and task-owned random local ports |
| RPC rerun | Four tests pass in a separate process after the timed-out package tests no longer affect its spawn mock |
| Hoisted resource/plugin tests | 38 tests and 257 assertions pass across six files, including repeated resource tests, trust/reload, no implicit HOME skills, SDK loader, codemode and the type consumer |
| Coding types and declarations | Root typecheck and actual declaration builds in both layouts pass |
| Hoisted server | Typecheck and build pass |
| Hoisted worker bundle | 26 tests and 105 assertions pass |

The 12-stage runner records 11 successful stages and one failed root-test stage.
PI_OFFLINE=1 skips updateConfiguredSources, so the fake npm update does not run.
The blanket fetch guard also blocks the fixture's random-port heartbeat. Two
update cases time out; their unfinished spawn mock then affects three RPC cases.
The original receipt remains failed. A separate rerun uses PI_OFFLINE=0 and a
fetch guard that permits HTTP to 127.0.0.1 on nonprivileged ports except 9100,
rejects redirects and blocks external fetch and WebSocket. Package and RPC
files run in separate processes. All 14 tests pass without repository code,
test, dependency or lock changes. Completed generation, probes, declarations
and bundle stages are not repeated.

The source registry updates 17 hashes, removes three entries and adds the two
bindings. The fixed Craft v0.15.6 audit passes over 2079 files: 1455 share paths,
873 are normalized-identical, 582 are modified Craft-derived, 624 are MkAgent-only
and 858 are reviewed Craft-only deletions. These results verify source records;
they do not establish the necessity of the remaining 65 src/pi files.

The parent then reproduced a new Native binding defect: spreading the options
object drops inherited or non-enumerable required fields, while the SDK accepts
them. The binding now reads and forwards the four public fields directly. The
existing alternate-directory fixture covers inherited and non-enumerable options.
Both layouts pass all 13 resource tests, 41 assertions each, after the fix; the
root typecheck also passes. These repeated resource cases are fix and layout
coverage. Public signatures, generated outputs, dependencies and SDK patches
are unchanged. The two source hashes are refreshed and the fixed Craft audit
passes again over the same 2079 files.

The independent read-only review found no reproducible new correctness defect.
Its 59 offline behavior and implementation checks pass. Resource and published
SDK boundary tests pass: 15 tests and 92 assertions. Nine API type-equivalence
assertions pass in an isolated consumer; Native config imports use their actual
declarations to isolate that type boundary. Both vendor checks, 19 current
source hashes and diff checks pass. The review compares normalized algorithms
and verifies independent Native and SDK directory defaults, explicit overrides,
legacy agentDir rejection and shared helper identities.

The review includes the direct ignore dependency and workspace lock removal.
Its reported stale current counts and lock description are corrected in the six
documents; versioned historical counts remain. The review finished before the
parent's later options fix, which has the separate regression evidence above.
ToolHtmlRenderer TS2308 remains when the two new root exports are removed. The
review's initial TS2846 came from a probe import of a declaration file; changing
it to import type lets the nine assertions pass. The review did not repeat
installation, full builds, broad suites, live services or platform checks.

F0 through F6 remain open. Remaining source, dynamic tools, codemode adapters,
SDK default-session shell policy and the existing custom AuthContext gap still
need their bounded checks. The existing ToolHtmlRenderer declaration ambiguity
and Photon release gap after a thrown orientation callback remain open.
Full-repository tests, real product UI, live accounts or providers, Windows and
Linux are not checked here.

## Public SDK usage, source and timing helpers after 8b00984

The Coding SDK now supplies usage-totals, source-info and timings through its
public root. Three complete local implementations, 228 lines, and two unused
compatibility forwards, four lines, are deleted. Their algorithms matched the
pinned upstream source before removal. The installed durable declarations do
not provide these Coding helper contracts. Durable still owns receipts and
ledger accounting; Native model-call presentation uses the SDK combiner.
Host resource discovery and trust decisions retain their existing policies.

The patch adds only exports to the existing root JS and declaration outputs.
All six helper JS/declaration files match pristine Coding SDK 1.5.0. No new
wrapper, dependency, lock, task or checkpoint version is introduced. The Native
entry keeps its existing createSyntheticSourceInfo export without adding a
second implementation. Equivalent upstream root exports will let this patch
retire. Generated imports stop at these SDK modules.

The runtime inventory decreases from 74 to 71 TypeScript files: 67 under src/pi
and four facades, with no assets. Auxiliary sources remain nine; shared entries
decrease from 18 to 16. Coding remains 54 physical patch outputs, core four and
durable 33, for 91 total. Full runtime, auxiliary and patch checks pass. A
pristine Coding replay matches every original and resulting hash. Both existing
installation layouts pass frozen installation with scripts disabled. All 54
Coding and 33 durable hashes match in each layout; both lock files remain
unchanged. These checks establish this slice's outputs, not the necessity of
all remaining source.

Checks use Bun 1.3.14, task-owned HOME/config/cache, an offline provider and the
network-blocking test preload. Type declarations go to the task directory.

| Check | Result and scope |
|---|---|
| Direct SDK helper probe | 35 assertions pass: root/internal function identity, optional cacheWrite1h/reasoning, provider cost ownership, totals, responseModel and Tools/summaries grouping, synthetic and symlink paths, metadata and one shared timing namespace |
| Root Coding tests | 30 pass, one type-consumer test fails; 227 assertion calls across seven files. The failure is preserved below |
| Hoisted resource/plugin tests | 39 pass, 351 assertions across six files; includes trust/reload, provenance, SDK loader, codemode and usage recovery. The repeated usage file is layout coverage, not additional distinct cases |
| Unchanged type consumer in hoisted layout | One test and four assertions pass, including actual declaration output |
| Coding types and declarations | Root typecheck and actual declaration builds in both layouts pass |
| Hoisted server | Typecheck and build pass |
| Hoisted worker bundle | 26 tests and 105 assertions pass, including offline resources, relocated images, controls and runtime updates |

The first 12-stage runner records 11 successful stages and one failed test
stage. shared-compat-types.test.ts hardcodes root node_modules for bun-types and
the Coding SDK. Those entries are absent in the root layout, causing TS2688,
TS2307 and the resulting unused expected-error diagnostic. The fixture is
unchanged from HEAD in both layouts. Its isolated hoisted rerun passes without
code, dependency or lock changes. The original failed receipt remains intact;
it is not reported as a successful root run. No completed install, helper
probe, declaration or bundle stage was repeated.

The source registry updates 17 hashes, removes five retired entries and adds
none. The fixed Craft v0.15.6 audit passes over 2080 files: 1455 share relative
paths, 873 are normalized-identical, 582 are modified Craft-derived, 625 are
MkAgent-only and 858 are reviewed Craft-only deletions. Source registration
and runtime inventories do not establish that the remaining source is needed.

The independent read-only review found no confirmed introduced defect. It
checked the 23 code, manifest and registry paths, the five deletions and all
327 tracked source, test and script files for retired helper references. It
confirmed the 17 current registry hashes and five removed entries. Compiled,
normalized old helper code matches pristine SDK code. All root value exports
share their internal bindings, and public types use the original declarations.

The reviewer passed 36 usage combinations, including optional splits, provider
cost ownership and input immutability. Totals, grouping, source metadata,
synthetic paths, symlink identity and missing-path fallback match the old
implementations. Deterministic timing checks cover shared main/extensions
state and silence with PI_TIMING=0. Durable receipt, ledger and accounted
logic are unchanged. The reviewer did not repeat installation, full suites,
builds or the Craft audit. These results support the five deletions only;
remaining resource discovery and codemode adapters still have host policies.

The complete SDK root declaration check reports TS2308 for ToolHtmlRenderer.
The same diagnostic remains after removing this slice's three added exports;
both restored root files match the HEAD manifest hashes. This is an existing
declaration ambiguity, not a helper regression. Successful declaration builds
above do not establish that the SDK has no declaration errors.

F0 through F6 remain open. The 67 remaining src/pi files still need review
against public SDK contracts. Full-repository tests, real product UI, live
accounts or providers, Windows and Linux are not checked here. The existing
custom AuthContext gap and Photon release gap after a thrown orientation
callback remain open.

## Public SDK image processing after 48aa826

The Coding SDK now owns image MIME normalization, conversion and dimension
hints, omission results, resize worker transport and fallback. Six local runtime
files are deleted: image-process, image-resize, image-resize-worker and the
image-resize-core, Photon and EXIF forwards. They total 284 lines. The retired
39-line Photon generator test and the unused image generation rules are also
removed. Existing output fixtures remain unchanged.

The 12-line native-image-process binding supplies the shared image converter,
the existing durable resize policy and an explicit host module URL. The SDK
patch adds optional createImageProcessor and createImageResizer dependencies.
Its worker loads the supplied module through workerData. The SDK keeps the
processing, hint, byte-copy, response-tag, error/exit, termination and fallback
algorithms. Default module APIs use default instances. The worker entry remains
relative to the installed SDK; it does not execute a project-relative worker.
The injected policy URL comes from the installed host module, not project
configuration or the current directory. A worker load or processing failure
uses the same instance's in-process fallback.

Durable still owns the encoding and size-reduction loop. Its preparation API
runs in the calling thread and has its own size and format contract. It does
not directly provide Coding hints, omission results or worker transport.
The existing host adapter keeps Native sequential dimension rounding and
metadata. It now imports shared Photon directly and reuses SDK resize types;
it no longer duplicates the retired worker protocol. No dependency, lock,
task, document or checkpoint version changes. Equivalent public dependency
factories and a worker policy entry would let these Coding patches retire.

The runtime inventory decreases from 80 to 74 TypeScript files: 70 under src/pi
and four facades, with no assets. The auxiliary check still passes for nine
sources and 18 shared entries. Coding adds four physical outputs and changes
the existing image-resize.js output. Its total is 54; core 4 and durable 33
remain unchanged, for 91 patch outputs. Full runtime generation/check, Coding
patch check and pristine replay pass, with every original and resulting hash.

An initial preparation script stopped because a test source anchor occurred
twice. Earlier edits remained in place; exact edits completed the remaining
test migration. The first install preparation was killed by an incorrect
1000 ms background deadline. No installer process, install log or receipt
remained, but pristine replay and part of the hoisted synchronization had
completed. A recovery precondition rejected an assumption that the hoisted
files were unchanged, before any cleanup. A separate continuation verified
all 54 replay hashes, classified each target as current, old HEAD or an
already completed deletion, and finished only the remaining work. Both existing
isolated and hoisted layouts then passed frozen install with scripts disabled.
All 54 Coding and 33 durable outputs match their manifests in both layouts;
the lock is unchanged. The interrupted attempt is not recorded as a pass.

All 11 final verification stages exit zero:

- Full runtime, Coding patch and auxiliary source checks.
- Root image, UI and boundary tests: 132 tests and 808 assertions in 11 files.
- Root Coding noEmit and actual declaration emission.
- Hoisted layout comparison: 23 tests and 257 assertions in six overlapping
  files. These are not added to the root total as distinct coverage.
- Hoisted actual Coding declarations, server typecheck and server build.
- Hoisted bundle: 26 tests and 105 assertions.

The new behavior checks cover MIME aliases, supported passthrough, converted
byte and option identity, conversion and dimension hints, disabled resizing,
omission messages, original conversion errors and instance isolation. A real
SDK worker loads the supplied test policy, reports a nonzero thread identity,
ignores an unrelated startup message and preserves caller subarray bytes.
Worker errors and missing policy modules use the instance fallback. Invalid
worker requests retain their original protocol error. Existing image checks
cover pinned Native resize results, all eight EXIF orientations, encoding,
shared Photon and relocated WASM. Bundle checks cover the project-relative
worker canary, relocated native/read images, resources, codemode/MCP startup,
cancellation, reload and session races.

Source registration updates 18 entries, removes seven and adds four. The fixed
Craft v0.15.6 audit passes for 2085 files: 1455 share a relative path, 873 match
after normalization, 582 are modified Craft-derived files and 630 are
MkAgent-only files. It also verifies 858 reviewed Craft-only deletions.

Independent read-only review found one source-registration delivery gap and
no confirmed new runtime, worker security or plugin API regression. The review
used the earlier registry state: seven retired entries, four missing entries
and 18 old hashes. The parent has since completed exactly those updates and
passed the fixed Craft audit above. A final scope check verifies all 36 changed
paths, each current source hash, all six runtime deletions, the 74-file runtime
inventory and the 54-output Coding patch digest. The registry finding is
resolved; the review does not establish completion of the remaining source.

The reviewer independently ran all six new behavior tests under Node 24.22.1.
A pristine SDK comparison passed 27 assertions across five resize cases and
12 MIME/option combinations, including orientation, quality reduction and
invalid images. An external NodeNext strict consumer passed factory type and
bidirectional resize signature checks with skipLibCheck enabled. The reviewer
also checked whitespace and read the implementation diff and four new files.
They read the parent receipts without repeating the full suites, installation
or build. Windows and signed release behavior remain unverified.

This slice does not complete the remaining 70 src/pi files or F0 through F6.
The existing AuthContext gap and the previously recorded Photon release gap
when orientation throws remain open. No full repository suite, real product
UI, account, paid model, Windows/Linux run, real terminal display or complete
product executable check was performed.

## Public SDK image converters after 9bd4b1e

The Coding SDK owns PNG conversion and Kitty transcoder registration. The local
89-line image-convert source copy is deleted. A 12-line native-image-convert
binding supplies the existing shared Photon loader and durable EXIF policy.
Its four exports directly reference functions from one SDK factory instance.
The local image-process, resize and other image responsibilities remain open.

The published durable/images preparation path selects size, quality and format.
It does not directly supply this PNG conversion and synchronous registration
contract. The Coding SDK already has those algorithms. A narrow local patch
adds createImageConverters with optional loadPhoton and applyExifOrientation
dependencies. It puts the existing function bodies and registration state in
instance scope. Default module exports use a default instance with the original
SDK dependencies. Conversion, release, failures and callback behavior stay in
the SDK. The patch can retire when an equivalent public factory is available.
No task, document or checkpoint version changes.

The runtime inventory decreases from 81 to 80 TypeScript files: 76 under src/pi
and four facades, with no assets. The auxiliary check passes for nine sources
and 18 shared entries. Coding adds two physical outputs for image-convert JS and
declarations; the root exports share existing outputs. The inventory is core 4,
Coding 50 and durable 33, for 87 outputs. Core and durable patches do not change.

Full runtime generation/check, Coding patch check and pristine replay pass,
including every original and resulting Coding hash. Both existing isolated and
hoisted layouts pass frozen install with scripts disabled. All 50 Coding and 33
durable outputs match their manifests in both layouts. The lock file is unchanged.

The first eight-stage runner records seven successful stages and a failed root
actual declaration emission. Root noEmit, hoisted actual declarations, server
types/build and the functional suites passed. The unannotated destructured
exports caused TS2742 for three functions in the isolated layout. Annotating the
whole destructuring statement with ReturnType still failed for those functions.
The final binding annotates each export with an indexed member of the public
factory return type. Actual declaration emission now passes in both layouts,
and hoisted server types pass again. The emitted declaration references only
the public SDK factory. The original failure receipts remain unchanged.

Functional checks passed before this final type annotation change:

- Root: 136 tests and 817 assertions across 11 image, UI and boundary files.
  These cover PNG passthrough, unavailable and rejected loaders, input subarrays,
  orientation result ownership, cleanup after encoding failure, per-instance
  registration, concurrent callbacks and non-Kitty behavior. Existing checks
  cover EXIF orientations 1 through 8, PNG/JPEG/WebP/GIF byte parity, MIME,
  resizing, durable encoding, renderer behavior and relocated Bun/Node WASM.
- Hoisted: 17 tests and 257 assertions across five overlapping files. These
  confirm the other installation layout and are not added to the root total.
- Hoisted bundle: 26 tests and 105 assertions, including relocated native/read
  images, shared Photon, the project-relative worker canary, resources,
  codemode/MCP startup, cancellation, reload and session races.

The final edit adds portable export types and direct references to the same
factory functions. The passed functional and bundle suites were not repeated
for that declaration correction. Both actual declarations and server types
were checked after the correction; the server build passed before it.

Source registration updates nine entries, removes one and adds three. The fixed
Craft v0.15.6 audit passes for 2088 files: 1455 share a relative path, 873 match
after normalization, 582 are modified Craft-derived files and 633 are MkAgent-only.
The audit also checks 858 reviewed Craft-only deletions. This uses an independent
reference checkout and does not access a live Craft installation.

The completed independent read-only review found no reproducible new defect.
Its TypeScript AST comparison confirms that encodePng, all four public function
bodies and both registration state declarations match pristine SDK text. Default
PNG/JPEG/WebP/GIF outputs match for factory instances, the default instance and
the public convertToPng export. Controlled promises confirm per-instance load
and callback coalescing. The TUI transcoder remains global: the last instance to
finish registration supplies it. The factory does not make that TUI resource
local to an instance.

Independent relocated Node bundles and an image-only Bun executable pass JPEG
and WebP checks for all eight EXIF orientations through both conversion entries.
Without the adjacent WASM, conversion returns unavailable and PNG passthrough
still works. A forged working-directory WASM is ignored, and fs.readFileSync
is unchanged. Public declaration consumers pass strict NodeNext and Bundler
checks with skipLibCheck enabled. A direct NodeNext host-source probe first
failed with TS2322 in unchanged compat/photon.ts; using emitted dependency
declarations passes. The project uses Bundler resolution. This probe failure
does not establish a new declaration defect. The review did not repeat the
parent declaration builds; the final portable export annotations are covered
by the parent checks above.

The review also reproduces an existing resource boundary. If orientation throws
after decoding creates a Photon image, encoding returns null without freeing
that original image. The same path exists at HEAD and in pristine SDK code.
It is recorded separately from new defects; this slice does not fix it. The
review checks image generation routes, manifest hashes, the exact 81-to-80
closure change, patch digest and whitespace. It did not repeat installation,
full replay or the parent suites. Parent evidence is under
/tmp/mkagent-image-convert-sdk-qTx1zs; independent probes are under
/tmp/mkagent-image-review-wLm43Q.

These checks do not close the remaining 76 src/pi responsibilities, AuthContext
or F0 through F6. The full repository suite, real product UI, accounts, paid
models, Windows/Linux, real terminal display and a full product executable are
not checked here. The previous UI section retains its own dependency-layout
failures and evidence.

## Public SDK UI components after f02db2e

The public Coding SDK now owns UI components, CustomEditor and the complete
ToolExecutionComponent renderer lifecycle. A 25-line native-ui module lists the
existing UI exports and subclasses only ToolExecutionComponent to bind PNG
registration to the shared Photon asset. Its inherited seven-argument
constructor and SDK state, lastComponent, argument batching, layouts, images,
mouse handling, fallback and invalidation remain in the SDK. MCP now imports
AuthUrlComponent and VisualLinePreview through added root exports of existing
SDK classes. One protected registration method retains the SDK default path
and lets Native bind its existing shared WASM. No component algorithm moves
into the patch. Public CLI, setup components and run modes remain excluded.

The local component barrel, its private-component filter and its test retire.
The generation boundary now stops at SDK components. In total, 41 tracked source
files and 8885 lines retire, including orphan component helpers, the external
editor, model search/refresh, experimental flag and HTTP dispatcher. Each file
matched the prior runtime hash before moving to Trash. Runtime now contains 81
TypeScript files: 77 under src/pi and four generated facades, with no assets.
The separate auxiliary check passes for nine sources and 18 shared entries.
The patch inventory is core 4, Coding 48 and durable 33, for 85 physical outputs.
Only the Coding patch changes in this slice; no task or serialized version changes.

Full runtime generation/check and pristine Coding patch replay pass, including
all 48 original and resulting hashes. Both existing normal and hoisted layouts
pass frozen install with scripts disabled. All 48 Coding and 33 durable outputs
match their manifests in both layouts, and the lock file is unchanged. An early
hook placement attached the argument batching comment to the new PNG method;
the generator now inserts the hook before that comment. The final patch was
regenerated, replayed and installed before the final functional checks.

The first seven-test UI run passed four and failed three. One assertion assumed
that the smaller compat entry exported the full UI; it never did. The test now
checks Native and both virtual Pi package names. Two mouse assertions rejected
the SDK dispatcher target metadata. They now check the handled field and supply
the complete mouse event. No API was expanded to satisfy those assumptions.
Final root UI, SDK boundary and generation checks pass 42 tests with 257
assertions across three files. Coding noEmit and actual declaration emission pass.

A root four-file plugin combination passed 46 tests and failed six: each failed
fixture could not resolve follow-redirects from the isolated root layout. The
root server type check also failed because @mkagent/core and @mkagent/shared
workspace links were absent, with related missing-module and derived type
errors. The package sources exist. The existing hoisted layout has those links
and follow-redirects. No runtime dependency was added for these checks.

The hoisted runner captures successful exit codes for all five stages:

- Ten related test files pass 80 tests and 453 assertions, including all plugin
  fixtures that failed to resolve in the root layout. They cover SDK identities,
  both renderer shells, frame batching, shared state, lastComponent, partial and
  final results, error fallback, mouse expansion, native/SDK default PNG paths,
  image cache/visibility and a relocated Bun bundle with only the shared WASM.
- Coding actual declaration emission, server type check and server build pass.
- Native extension UI with a local kernel passes 19 tests and 82 assertions,
  covering startup, reload, dialogs, cancellation, disconnect/reconnect and
  session close/replacement races. This uses deterministic local data.

The root 42 tests overlap the hoisted suites and are not added to that total.
Source registration updates 11 entries, removes 41 and adds four. The fixed
Craft v0.15.6 source audit passes for 2086 files. This checks the independent
reference checkout, not a live Craft application. All six documents pass
punctuation checks and all 153 local links resolve.

The completed independent read-only review found no verified new correctness,
plugin compatibility or publication defect. Seven additional loader, editor and
renderer probes pass with 93 assertions. An external strict declaration
consumer passes with skipLibCheck enabled, covering CustomEditor subclasses,
ExtensionUIContext factories, inherited ToolExecutionComponent construction and
protected override, plus both MCP classes. Native did not export
ToolRenderContext at HEAD; the probe imports it from the official SDK and does
not treat that existing boundary as a new defect. Node 24.22.1 passes the SDK
default PNG path and a relocated shared-WASM bundle without project or parent
node_modules, build-machine WASM reads or network access. Both checks cover
PNG output, cache and visibility.

The review scans 1238 existing package source files and 2823 relative references
with no remaining reference to the 41 deleted files. Runtime token comparison
matches 36 deleted component/internal files against pristine SDK code after
removing types, module declarations and comments. All 81 runtime hashes and 48
SDK hashes pass. A trailing blank line in shared-runtime-port.test.ts caused the
review whitespace check to fail; that line is removed and git diff --check now
passes. The review did not repeat installation, the server build or the full
parent suites. Their successful exit codes come from the parent runner.

The existing image-convert helper still contains SDK-derived PNG conversion and
transcoder registration logic to bind shared Photon. That remaining copy and
AuthContext remain open, as do the other source responsibilities and F0 through
F6. These checks do not cover the full repository suite, a new product UI
session, accounts, paid models, Windows/Linux, live OAuth/clipboard/browser
flows or a standalone executable. Evidence is under
/tmp/mkagent-ui-sdk-4YCu2K and /tmp/mkagent-ui-review-uTREMA.

## Public SDK codemode factories after d581616

The Coding SDK now owns codemode descriptions, declarations, loadout selection,
grammar, rendering and its three factories. A 32-line native-codemode binding
supplies the existing durable executor through an optional dependency. It passes
the original options and keeps the SDK default lazy executor when no dependency
is supplied. Five local files retire: execute.lazy (2 lines), execute (2), index
(49), renderer (166) and tool (434), for 653 lines. The obsolete executor-forward
generation rule also retires. Runtime now has 122 TypeScript files, including 118
under src/pi and four facades, with no assets. The auxiliary check confirms nine
sources and 18 shared entries; removing the generation rule does not reduce that
separate inventory to 17.

The durable patch exposes its existing source/declaration helpers, Node sandbox,
WASM location and worker through public entry points. These exports are local
SDK changes. They reuse durable's own pi-codemode dependency without copying its
implementation. Both workspaces remove their direct pi-codemode dependency; the
official SDK transitive dependencies remain. Native code still binds ToolTask
ownership, hidden child tools, approval, branch store, progress, usage and worker
leases. Task, document and replay module versions do not change.

Initial installation, an attempt with standard blob headers and a minimal
installation all failed with EACCES during mkdir. The exact
[Bun 1.3.14 implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/patch/patch.zig)
creates new-file parent directories with the file mode, 0644, using a relative
path. An isolated check applied all 33 patch sections successfully after moving
only the four new modules to the package root. The final exports still use
/codemode/node and /codemode/worker; their physical modules use flat paths. The
worker initialization module is listed in sideEffects. Empty directories left
by failed attempts were inspected and moved to Trash. No permissions or shared
cache were changed.

Comparison with the prior patch also found that the first export generator
omitted existing store, lease, output and model exports. The generator now
preserves those contracts. The final patch has 33 durable outputs and 46 Coding
outputs, plus four core outputs, for 83 physical files. Full pristine patch
replay and runtime generation checks pass. Both existing normal and hoisted
installations pass frozen install with scripts disabled. Every Coding and durable
output matches its manifest. The lock change is exactly the removal of the two
workspace dependency declarations.

The first factory test run passed five tests and failed one because it compared
an AgentTool renderer with a ToolDefinition renderer. The SDK AgentTool factory
does not expose that renderer. The assertion now compares corresponding SDK
factories; production behavior was not changed for the test. Final checks pass:

- Six factory and bundled-worker tests, 42 assertions. They cover inherited
  options and receivers, nested calls, store writes, loadout and discovery,
  the SDK default executor and a worker running without project node_modules.
- 137 related codemode and generated-boundary tests, 627 assertions, in 13 files.
- 26 worker bundle tests, 105 assertions.
- Coding and server type checks, actual declaration generation in both normal
  and hoisted layouts, full runtime and auxiliary source checks, and both full
  SDK patch checks.

The total is 169 tests and 774 assertions, with no final failures. Source
registration updates 31 entries, removes five and adds four. The fixed Craft
v0.15.6 audit passes for 2123 files. All six documents pass punctuation checks
and 147 local links pass validation.

The independent read-only review found no verified new defect from this slice.
It passed 109 tests with 669 assertions in 13 related files, plus six factory
and worker tests with 42 assertions in the hoisted layout. It also checked both
manifest inventories, full patch replay, runtime generation and declaration
output. An external NodeNext consumer probe passed with skipLibCheck enabled.
Node 24.22.1 passed public entry point, default and durable worker, WASM loading
and relocated bundle checks. The review scripts needed layout path corrections
and a new process after dependency links were created; no source change was
needed. Review evidence is under the temporary directory's review subdirectory.
The review did not repeat dependency installation, a full server build or the
whole repository test suite. It used existing server bundle logs and did not
validate Windows, Linux, product UI, Craft, accounts or paid models.

The ordinary whitespace check reports seven space-before-tab lines in the new
patch context because the upstream package.json uses tabs. Those exact context
lines are checked separately; other changed text uses the default whitespace
check. The upstream JSON format remains unchanged.

These checks do not cover a new product UI session, real accounts, paid model
calls, Windows hardware, every standalone consumer layout or all codemode
documentation publication forms. F0 through F6 and the remaining source review
stay open. The temporary evidence directory is
`/tmp/mkagent-codemode-sdk-Pmgket`.

## Public SDK shell factories after 145dd49

The public Bash and PowerShell factories now use the Coding SDK. Four local
files retire: Bash (441 lines), PowerShell (67), output accumulator (257) and
shell renderer (109), for 874 lines. Runtime falls from 131 TypeScript files to
127, including 123 under src/pi and four facades, with no assets. Auxiliary
sources remain nine and shared entries 18. These counts do not establish that
the remaining source is necessary.

Production shell tools continue to use durable. Its tool factories do not
provide the Coding plugin operations, ToolDefinition and renderer contracts.
The 42-line native-shell-tools binding passes the original options to the SDK
and supplies existing host policies: shell selection, managed bin PATH, durable
waiting and process-tree termination, and the shared detached process tracker.
These preserve WSL stdin transport, the trusted Windows taskkill path and the
macOS stop-before-kill order. The SDK still owns spawn, timeouts, cancellation,
UTF-8 processing, output accumulation, private spill files and rendering.

The narrow SDK patch adds optional ShellDependencies. PowerShell selects default
operations through a delayed factory, so inherited and non-enumerable options
and getter receivers survive without an options spread. Omitted dependencies
keep SDK defaults. Four shell JS/declaration files are added to the Coding patch,
which rises from 38 outputs to 42. With the unchanged core four and durable 28,
the total is 74 physical outputs. Public equivalent dependency hooks are the
exit condition for this patch; no task, checkpoint or dependency version changes.

The complete Coding patch replays against a pristine package, and all 42 original
and target hashes match. Both existing installations pass frozen refresh with
scripts disabled and a task HOME/cache; bun.lock is unchanged. The 42 installed
Coding outputs match the manifest in both layouts. The fixed upstream runtime
--check verifies 127 files, and the SDK patch --check verifies all 42 outputs.
Only manifest policy text changes after those checks; regeneration and --check
confirm identical patch bytes and output hashes.

The parent runs 36 shell tests with 238 assertions, 72 related tests with 225
assertions, and 26 bundle tests with 105 assertions: 134 tests and 568 assertions.
Coverage includes options and receivers, session environment, real shell errors,
UTF-8 spill bytes and mode 0600, cancellation and timeouts, tracking, injected
PowerShell transport and renderer component reuse. Coding and server types pass.

Independent review finds one new defect: both definition factories infer private
SDK Bash render types. Root declaration generation reports TS2742; hoisted output
can include an internal node_modules path. The reviewer confirms the failure
against an in-memory HEAD baseline. The parent adds public ReturnType annotations
and then generates declarations successfully in both actual installations. Both
shell declaration files use only public SDK imports, and server type consumption
passes again. The review also reports a separate existing context declaration
TS2742; the parent's final root and hoisted commands do not reproduce that error.
The two-line fix is verified by the parent without a second independent review.

The reviewer runs 74 related tests and six local process probes under each of
Bun and Node. These check the shared tracker, child-tree termination, continued
descendant output, idle pipe release and policy transform guards. All pass.
The reviewer also verifies the four deletions against fixed upstream, unchanged
SDK accumulator and renderer bytes, all 42 hashes and the full runtime --check.
Installation, patch replay, bundle, source registration and document updates are
outside the independent review. Source registration updates eight entries,
removes four and adds three; the fixed Craft v0.15.6 audit passes for 2124 files.

The native/compat factories and tool collection use the host binding. AgentSession
without baseToolsOverride and its interactive executeBash still use SDK internal
default factories, as they did at HEAD. These factory tests do not establish host
policy coverage for those paths. Real services, Windows and Linux devices and
complete repository or product acceptance are not checked. Remaining source
deletion, the earlier AuthContext gap and F0 through F6 stay open.

## Durable tool patch cleanup after 2951fe6

The local read path adapter and edit preview implementation have already retired.
Seven low-level diff exports and readPathVariants have only historical test
consumers. The durable tools entry now adds only generateDiffString and
generateUnifiedPatch. Both path-utils files return to their published bytes;
no path or diff algorithm moves into local source. The durable patch shrinks
from 30 files to 28. Its other 26 outputs are unchanged. Core four and Coding 38
remain unchanged, giving 70 physical patch outputs.

The fixture retains 216 cases for the two supported diff functions, selected by
name from the unchanged 305-case original baseline. Cases still cover context
limits, BOM/CRLF, Unicode and unpaired surrogates. The 89 cases for retired
low-level helpers and metadata are no longer an export requirement. Three private
path normalization tests and their unused 55-line file are removed. Public read
factories still verify real path candidates, missing files and malformed URLs;
public edit tests still verify preparation, operations, cancellation and previews.

Initial preparation stops before writes because the isolated installation is
hoisted and the older frozen durable copy is already patched. The corrected
preparation copies that package, checks all 30 patched hashes, reverses the full
old patch in the task copy and checks all 30 original hashes. It then checks both
installed packages before making the four intended tool-file changes. The full
patch generator replays the new patch against this verified original package and
its --check passes.

Both existing installations pass frozen refresh with scripts disabled and a task
HOME/cache. The lockfile is unchanged. All 28 durable and 38 Coding outputs match
their manifests; the four unchanged core outputs match across installations.
The restored path files match the original package in both installations. This
refresh does not replace the earlier evidence for a completely new installation.

Eight public tool and generation-boundary test files pass 327 tests with 663
assertions. Worker bundle tests pass 26 tests with 105 assertions. The total is
353 tests and 768 assertions. Coding types, declaration emission and server types
pass. Source registration updates four entries and removes one; the fixed Craft
v0.15.6 audit passes for 2125 files. Runtime remains 131 TypeScript files,
including 127 under src/pi, with no assets; auxiliary sources remain nine and
shared entries 18. The unchanged runtime generator is not rerun for this cleanup.

Independent review against 2951fe6 finds no verified defect. The reviewer checks
2204 tracked and unignored files for consumers, replays both complete patches,
checks all original and target hashes and verifies both installations. Five
related test files pass 282 tests with 592 assertions; Coding and server types
pass. Bun and Node each pass all 305 historical internal diff cases, four durable
path checks, five actual read cases and four actual edit cases. Retained case
names and historical names are unique. The first cancellation probe expects
Coding error text; after correcting it to durable's existing FileError with
code aborted, both runtimes pass. Duplicate and overlapping edits and early
cancellation leave file contents unchanged. The five reviewed paths and bun.lock
remain unchanged throughout review.

The reviewer does not rerun frozen installation, bundle, the complete generator
--check or the whole repository, and excludes the source register and six parallel
document updates. The parent checks punctuation and all 135 local links in those
six documents. This section does not establish complete repository or product
acceptance. Real services, Windows and Linux devices, remaining source deletion,
the earlier AuthContext gap and F0 through F6 remain open.

## Edit SDK boundary after cfefb9b

Production edit continues to use durable. Both plugin edit factories delegate
execution and rendering to the public Coding SDK. Its operations contract,
context directory, shared file mutation queue and renderer match the required
plugin behavior. Durable's public edit registration instead uses its execution
environment and schema and does not provide the Coding operations or renderer.
The 20-line host adapter only binds durable prepareArguments and exports
public diff functions directly from durable. Durable preparation preserves
frozen inputs and recorded arguments; the SDK's default preparation can mutate
the edits array. Options pass directly to the SDK without object spreading.
There is no new SDK patch, dependency, lockfile or task/checkpoint version.

Four generated files are removed: edit.ts, renderers/edit.ts, edit-diff.ts and
path-utils.ts, totaling 652 lines. The unused edit-diff conversion script and
compat/read-path.ts are also removed, giving six retired files and 741 lines.
The generator stops at the edit and diff boundaries. The first deletion guard
expects only three generated files and rejects the extra retired path-utils.ts
before deleting anything. Call-site checks establish that only the retiring edit
files consume it. The unused path conversion and adapter are then removed.
Full runtime --check passes with 131 TypeScript files: 127 under src/pi and four
facades, with no assets. Auxiliary sources remain nine and shared entries 18.
Core four, Coding 38 and durable 30 patch outputs remain unchanged at 72.
The earlier durable helper export and path-generator patches remain a separate
cleanup item; tests alone do not establish a production need for those exports.

The isolated prototype passes 12 tests with 26 assertions. Nineteen new behavior
tests pass against the old implementation before replacement, with 51 assertions.
The final six-file edit group passes 383 tests with 766 assertions. The three-file
read/path group passes 36 tests with 83 assertions, including 14 actual public
factory path checks. The bundle group passes 26 tests with 105 assertions.
Together these are 445 related tests and 954 assertions, not all new tests or
complete repository acceptance. Coding tsc --noEmit, declaration emission and
server types pass. Tests cover BOM/CRLF, fuzzy matching without changes to other
bytes, file URLs, inherited options, operations receivers, ctx.cwd, original
errors, pre-cancellation, in-flight cancellation at all three file stages, queue
settlement, preview errors and component reuse. Historical pure diff digests now
run against durable. Private preview and path-helper tests are replaced by public
renderer and real-file factory checks; obsolete generation fixtures are removed.

Source registration initially updates 14 hashes, removes six retired entries and
adds the adapter and contract test. The first fixed Craft v0.15.6 audit passes for
2127 files. The existing isolated installation receives source updates only.
Dependencies, lockfiles and SDK patches do not change, so installation and the
unchanged pristine patch checks are not repeated.

Independent review against cfefb9b finds one type fixture defect and no confirmed
runtime regression. Moving module augmentation to the durable tools entry does
not extend the internal return interfaces. The isolated fixture produces two
TS2339 diagnostics; the exact baseline has none under the same compiler options.
The retired local interface no longer needs this augmentation fixture. The parent
removes the unused 10-line fixture and its source entry, syncs the isolated copy
and reruns Coding types successfully. Final registration updates 13 hashes,
removes seven files and adds two. The final fixed Craft audit passes for 2126
files. The six runtime and conversion retirements remain 741 lines; the fixture
adds 10 lines. Runtime and SDK patch outputs do not change.

The reviewer independently passes 419 tests with 849 assertions across nine
files, plus 14 contract probes with 755 assertions. These include all 305 golden
diff cases against SDK internals, aggregate and plugin exports, frozen input,
operations, failure atomicity, cancellation, queue settlement and renderer
lifecycle. Coding types and the complete 131-output runtime check also pass;
22 relevant isolated files match the workspace. The reviewer does not rerun
server types, worker bundle, the whole repository, Windows or remote operations.
The parent removes the obsolete fixture after review; no second independent
review is requested for that deletion. Punctuation and all 130 local links pass
across six documents.

Real services, Windows and Linux devices, crash recovery during edit and complete
repository or product acceptance are not checked here. Remaining source and patch
cleanup, the earlier AuthContext gap and F0 through F6 stay open.

## Read SDK boundary after 7596356

Production read continues to use durable. The plugin factories now call the
public Coding SDK, which supplies reading, paths, pagination, cancellation,
structured output and rendering. Durable's public read factory accepts an image
processor, but its execution environment, results and diagnostics do not supply
the Coding plugin operations and renderer contract. The host adapter binds the
existing shared image processor, durable MIME detection and documentation path;
it does not retain the read or renderer algorithms.

Two optional ReadToolOptions hooks are local SDK changes. processImage binds the
existing durable/Photon path, which the AgentSession prompt-image hook does not
cover. getReadmePath keeps host README, docs and examples classification in the
SDK renderer. The renderer factory closes over that callback without rewriting
its algorithm. Without the callback, the SDK retains its default renderer
singleton. No private SDK subpath import is added.

The generated boundary stops at core/tools/read.ts. The local read factory,
223 lines, and renderer, 173 lines, are deleted, totaling 396 lines. Full runtime
--check passes for 135 TypeScript files: 131 under src/pi and four facades, with
no assets. The shared image processor remains an explicit generator root because
authored session and read adapters use it outside the generated import graph.
The first closure omitted that root; it was corrected before deletion, and only
the two read files were removed. Auxiliary sources remain nine and shared
entries remain 18. The final pristine SDK patch --check passes for 38 Coding
outputs, with core four and durable 30 giving 72 physical outputs. Dependencies,
lockfile, task and checkpoint versions do not change.

The first baseline cancellation fixture waits in the wrong order and reaches the
120-second runner limit. A normal rejection handler fixes the fixture; the local
baseline then passes 17 tests with 42 assertions. The first replacement run has
935 passes, one failure and one error because a new test context has a missing
closing brace. Correcting that fixture gives 954 passes with 2112 assertions.
A later renderer check exposes a real regression: the SDK package root no longer
classifies the host README as "read docs". That run has 18 passes and one failure.
The optional documentation path hook fixes it, and the regression remains in the
final tests. These fixture failures do not require changes to product cancellation.

The final six-file read group passes 954 tests with 2112 assertions. The separate
path group passes 20 tests with 74 assertions, and the worker bundle group passes
26 tests with 105 assertions. These are related existing and new tests, not 1000
new read tests or complete repository acceptance. They cover raw bytes, BOM,
Unicode, CR/CRLF, file URLs and path fallbacks, inherited options and custom
operations, ctx.cwd, original errors, cancellation, line and byte truncation,
structured text and images, model resize overrides, resource/docs classification
and renderer component reuse. Relocated bundles produce a read image with only
the existing shared Photon WASM while build-time Photon reads are blocked; the
project-relative image-worker canary remains untouched. Coding declarations and
server type checks pass. Configuration and files remain isolated to the task.

The existing root and isolated hoisted installations are refreshed with frozen
lockfiles and scripts disabled. Both preserve the lockfile hash, and all 38
installed Coding outputs match the final manifest. These are installation
refreshes, not new empty-directory installations. Source registration updates ten
hashes, removes two retired entries and adds the adapter and contract test. The
fixed Craft v0.15.6 audit passes for 2131 files. The six-document punctuation
checks and 127 local links and anchors pass.

Independent read review against 7596356 confirms no actionable defect. It reruns
the six-file 954-test group and the separate 20-test path group, then passes 22
contract probes with 843 assertions, including 624 baseline text and truncation
comparisons. The probes cover public and aggregate factories, both plugin module
names, inherited options, operations receivers, paths, original errors, staged
cancellation, PNG/BMP images, renderer classification and component reuse. Coding
tsc --noEmit, patch --check, 38 patch hashes across pristine and both installed
copies, 135 generated output hashes, 131 src/pi paths and 344 static relative
imports also pass. The removed runtime bodies match pristine SDK tokens after
type and import differences are removed. Initial probe failures come from
hoisted/ESM resolution and four incorrect assumptions about AgentTool renderer
properties; corrected probes pass. The reviewer does not rerun worker bundle,
server types or the full runtime generator, and does not approve the final docs
or source-registration bookkeeping. These remain the parent checks above.

Real services, Windows and Linux devices, crash recovery during a read and
complete repository or product acceptance are not checked in this slice. The
remaining source replacement, the earlier AuthContext gap and F0 through F6
stay open.

## Write SDK boundary after 1765fd7

Production write continues to use durable. The plugin write factory and tool
renderer now come directly from the public Coding SDK. Its existing options,
custom operations, context directory and shared file mutation queue preserve
the plugin contract. The durable write factory requires its execution environment
and does not expose these Coding plugin options. The earlier durable adapter
prototype retained the file execution body and added environment and result
bridges. The Coding SDK supplies that complete implementation without a new
runtime wrapper or SDK patch.

The generated source boundary now stops at core/tools/write.ts. The local write
factory, 96 lines, and renderer, 192 lines, are deleted. The full runtime source
check passes with 137 TypeScript files: 133 under src/pi and four facades, with
no assets. Auxiliary sources remain nine and shared entries remain 18. Physical
patch outputs remain core four, Coding 34 and durable 30. Dependencies, lockfile,
SDK patches, tasks and checkpoint versions do not change.

Before replacement, the new write contract tests initially pass seven tests and
fail two because of fixture setup. Direct edit execution requires a prepared
edits array, and the renderer requires theme initialization. The fixtures are
corrected without a product change; the baseline then passes nine tests with
24 assertions. After replacement, five related test files pass 349 tests with
827 assertions. These include bytes, Unicode, BOM and CR/CRLF, parent creation,
file URLs, overwrite, inherited operations read once, ctx.cwd, original errors,
cancellation during mkdir and write, shared edit queues and streaming renderer
component reuse. Coding declaration generation and server type checks pass.
All 26 worker bundle tests pass with 103 assertions. These checks use isolated
task configuration and files. They do not access real accounts or services.

Source registration removes the two deleted entries, updates four hashes and
adds the write contract test. The fixed Craft v0.15.6 audit passes for 2131 files.
The six-document punctuation checks and 121 local links and anchors pass.
Independent review against 1765fd7 confirms no new correctness or compatibility
defect. The reviewer independently passes 11 tests with 68 assertions and seven
additional compatibility and HEAD comparison groups. These cover both plugin
module names, inherited operations, getter access, bytes, original errors,
pre-cancellation, queue release, symlink-alias write/edit ordering and renderer
states and component reuse. The deleted write and renderer execution statements
match the SDK after transpilation with imports, types and comments excluded.
All 137 runtime file hashes are checked. The reviewer changes neither shared
source nor the test installation, and confirms the durable factory boundary.
Complete type checks, worker bundle and full generator --check use the parent
results and source review; they are not independent reruns. Windows and real
remote operations are not checked.

The remaining source replacement, the earlier AuthContext gap and F0 through F6
stay open. Real services, Windows and Linux devices, crash recovery during a
write and complete repository or product acceptance are not checked in this
slice.

## Production search SDK boundary after c032e05

The production builtin entry now uses the same public Coding SDK grep, find and
ls factories through the existing agentToolToHost bridge. Three local tool
implementations, 545 lines, are deleted. A 27-line search.ts binds the product
binary resolvers and each call's abort signal. Its grep read operation preserves
the product's CR-only and CRLF context splitting. The SDK owns search, process
handling, limits, truncation and results.

The product resolver retains managed binaries, PATH, bundled ripgrep, Debian
fdfind, PI_OFFLINE and cancellation during safe downloads and extraction. Each
execution creates a factory bound to its own signal, so concurrent calls cannot
share resolver signals. Grep now uses the SDK's existing --no-config option.
An isolated subprocess test verifies that RIPGREP_CONFIG_PATH cannot change the
requested regular expression into a fixed-string search.

The original search and binary cancellation tests pass before replacement.
After replacement, search and binary policy tests pass 33 tests with 109
assertions. Isolated cancellation tests pass 22 tests with 120 assertions,
including two new concurrent-call cases. The existing bridge and metadata tests
pass 20 tests with 135 assertions. All 26 worker bundle tests pass with 103
assertions. Search tests now call createBuiltinTools, the production entry, and
cover Unicode, hidden and ignored paths, limits, errors, CR and CRLF, path globs,
nested repositories, file URLs and cancellation before execution.

The first server type check fails at two resolver callbacks: an unnecessary
conversion returns null, but the SDK expects string or undefined. Both callbacks
now return the product resolver promise directly. Coding declaration generation
and server type checking then pass. Search and cancellation tests pass again
after this correction. The bridge and bundle checks precede this two-line type
correction and are not repeated. The initial type error log is preserved.

No dependency, lockfile, SDK patch, task or checkpoint version changes. The
runtime inventory remains 139 TypeScript files, including 135 under src/pi,
and the physical patch outputs remain core four, Coding 34 and durable 30.
Source registration removes the three deleted tool entries, updates the builtin
and two test hashes, and adds the small search adapter. The fixed Craft v0.15.6
audit passes for 2,132 files. Task logs and receipts are in the
mkagent-production-search-sdk-VSZdT6 directory.

Independent review against c032e05 confirms no new correctness or compatibility
defect. The reviewer independently passes the 33 search and binary policy tests
and 22 cancellation tests. Another 33 baseline comparison cases match. Actual
search tools pass three permission-change cases, three permission-denial cases
and three invalid-argument cases through durable ToolTask, including approved
argument memos, execution records and persisted results. Running grep and find
processes exit on cancellation while concurrent calls on the same registration
still succeed. Early probe attempts fail because of temporary script paths and
assertions; the corrected final probes pass. The reviewer does not change the
shared source or test installation. Existing bridge, type and bundle logs are
read-only evidence, not independent reruns.

The review confirms that the new adapter copies no search algorithm. It also
identifies unused baseline exports truncateHead, truncateLine and
GREP_MAX_LINE_LENGTH in the product's local/truncate.ts. The file still supplies
formatSize and truncateMiddle to MCP; this remaining cleanup is not a new runtime
defect. Six document punctuation checks and 115 local links and anchors pass.

Remaining source replacement, the earlier AuthContext gap and F0 through F6 stay
open. Real services, Windows and Linux devices, search crash recovery and complete
repository or product acceptance are not checked in this slice.

## Search SDK boundary after a567bf4

Durable 1.5.0 does not provide grep, find or ls factories. The public Coding SDK
provides them. Search execution and rendering now use that SDK. Six local files
are deleted: three tools and their three renderers, 1,044 lines in total. The
runtime inventory has 139 TypeScript files: 135 under src/pi and four facades,
with no assets. The auxiliary inventory has nine sources and 18 forwards.

The SDK patch adds optional ensureTool configuration to grep and find and exports
existing prompt contributions and the path helper from the root. Four local
factories pass operations and bind the existing host resolver. That resolver
keeps the managed binary directory, PI_OFFLINE, platform checks and safe ZIP
installation. Without configuration the SDK still uses its own resolver. The ls
factory uses the SDK directly. The SDK retains search, path, limit and renderer
algorithms. Generation stops at those module boundaries and keeps tools-manager
as an explicit source root. No dependency, lockfile or persisted version changes.

The first six-test run passes five tests and fails one because the ls assertion
omits the SDK's existing Use limit=4 for more hint. Only the assertion changes.
Additional cancellation tests then pass seven and fail two. Grep can continue
after cancellation during binary resolution or a custom directory check. Two
checks after those asynchronous operations fix the failures. The nine-test set
then passes with 24 assertions. The related six-file set passes 46 tests with
269 assertions. Coding declaration generation, server type checking and all
26 worker bundle tests with 103 assertions pass. These checks precede the later
four-factory fix described below.

A fresh HOME/cache, hoisted, frozen install with scripts disabled verifies all
68 physical patch outputs against the tested installation: core four, Coding 34
and durable 30. All 34 Coding outputs also match their manifest. Strict public
consumer types and the nine search tests pass. The lockfile stays unchanged.
The first installation script has an extra closing parenthesis and stops during
parsing; it does not start an installation. The corrected script completes the
fresh installation and checks.

Independent review confirms one new adapter defect. Spreading options drops
inherited or non-enumerable operations and can replace a remote search with local
binary resolution or process execution. The reviewer reproduces the difference
against the previous local factories, verifies the installed output hashes and
compares 12 output-limit cases. No other new defect is confirmed in that review.
The review does not cover the six documents or complete repository acceptance.

The main thread adds 12 cases for four factories and three property forms:
inherited, non-enumerable and enumerable getters. Before the fix, 13 tests pass
and eight fail. The adapter now reads operations directly and no longer spreads
options. All 21 tests pass with 54 assertions, including one getter read per
factory. Coding declaration generation passes again. The two changed sources
are copied to the existing fresh consumer after old-hash checks. Its 21 search
tests and strict public types pass without another installation. The earlier
bundle and server checks are not repeated for this property-copy fix. There is
no second independent review of the four changed lines.

Full runtime, auxiliary and pristine SDK patch checks pass. Source registration
covers 16 code and artifact paths, removes six old records and adds three new
files. Two source hashes are updated after the options fix. The fixed Craft
v0.15.6 audit then passes for 2,134 files. Document links, punctuation and final
diff checks are recorded with the local commit. Task receipts are in the
mkagent-search-sdk and mkagent-search-hoisted directories.

At that slice, the separate production tools/local/grep.ts, find.ts and ls.ts
still use their product resolver and durable ToolRegistration contracts. That
slice does not replace them; the production replacement is recorded above.
Remaining source replacements, the earlier
AuthContext gap and F0 through F6 stay open. Real services, a Windows device and
complete repository/product acceptance are not checked here. The managed binary
fixture needs POSIX and is skipped on Windows; the other operation, cancellation
and Windows path-helper cases do not use that fixture.

## AgentSession SDK boundary after 5a72c8a

The public Coding SDK now owns the session lifecycle, tool registry, plugin input,
retry and export algorithms. The local native-agent-session.ts subclass binds
that lifecycle to durable settlement, accepted input queues, journal identities,
summary streams and compatible snapshots. The SDK patch adds optional hooks and
protected declarations. Without those hooks, the SDK keeps its original loop.
No task, document, checkpoint or codemode module version changes.

Seventeen files are deleted: the full local session class, unused helpers, tool
conversion, HTML implementations and four assets, sleep and ZIP forwards, and
the old input conversion script. ZIP writing, sleep and tool conversion use the
SDK. Safe JSZip extraction remains local, with path and file type validation.
The direct fflate dependency is removed. The worker copies four HTML assets
from the SDK and adds two browser vendor assets. Runtime generation now covers
145 TypeScript files, including 141 under src/pi and four facades, with no assets.
The auxiliary inventory has nine sources and 18 forwards. Coding has 30 physical
patch outputs, core four and durable 30, for a total of 64.

The initial focused set passes 199 tests with 1,018 assertions in 17 files.
The HTML, archive and sleep set passes 36 tests. These checks precede the final
review fixes; they are not new runs of the final version. The original admission
fixture first lacks a registered local provider and has an incorrect expected
message list. It also waits on a rejection matcher before it triggers rejection.
The fixture now registers its provider, expects system/user/assistant messages,
and attaches an error handler before it rejects the promise. A sleep check finds
an abort listener left after normal completion; the SDK patch removes it on both
completion and abort. The archive filename limit raises RangeError; the test
checks that error and retains the boundary case.

The first production follow-up check times out because SDK tool conversion loses
the host execution Symbol. The accepted tool then enters the host ToolTask twice.
The patch preserves declaration metadata and own Symbol property descriptors
through both conversions. The original follow-up identity test passes without
a larger timeout. The image worker canary also fails: the SDK executes a worker
relative to the project directory under Bun. That branch is removed. Both the
SDK and retained local image entry use a module URL or process the image locally.
The original canary assertion remains.

Independent review confirms two more regressions. SDK nested extension calls
use core.runToolCall and lose durable child ownership. SDK boundary and virtual
model projections retain hostMessageId and hostUserInput. Provider requests
already remove those fields. Two new integration tests fail before the fixes.
Optional runToolCall and convertToLlm configuration now binds the existing
durable executor and host projection rule. The SDK retains nested scheduling,
hooks and default functions. The tests verify distinct parent and child durable
tasks, the child call identity, successful host-wrapped execution, clean turn_end
and provider contexts, and unchanged transcript and journal input metadata.
The first success assertion uses the wrong status value, success; the published
nested runner uses ok. The corrected fixture keeps all ownership and result
assertions. The tool metadata fixture also uses public namespace, annotation
and reachesTools types.

After these fixes, the session/tool set passes 15 tests with 107 assertions.
The production recovery set passes 43 tests with 313 assertions. It covers
original input identity, queued follow-up, rejected admission/commit, old phases,
full tree projection, receipts and actual SIGKILL recovery with SQLite and JSONL.
The complete worker bundle set passes 26 tests with 103 assertions, with a
15-second command budget and unchanged repository test timeouts. Coding
declaration generation and server type checking pass. Full runtime, auxiliary
and pristine SDK patch checks pass. The source record covers 61 slice paths,
removes 17 retired records and adds four authored files. Seven changed records
are updated after review. The fixed Craft v0.15.6 audit passes for 2,137 files.

A first fresh hoisted frozen install verifies all 64 outputs but its temporary
public consumer uses incorrect namespace and exposure types. That consumer is
corrected to the published types and passes with the original installation.
After the review fixes, another fresh HOME/cache install with scripts disabled
passes installation, all 64 output hashes, strict public types for the two new
bindings, and the 15 session/tool tests. The lockfile stays unchanged. Both the
failed consumer result and its correction remain in the task receipts.

The recheck confirms the two fixes and finds a release image regression. The SDK
session uses photon-node 0.3.4, but the worker ships the shared photon 0.3.3 WASM.
Their import namespaces differ. When the build dependency is absent, Photon
loading fails and the SDK substitutes an Image omitted hint. A relocated image
test now rejects Photon WASM reads from node_modules in its child process. It
fails before the fix with images:0 and exit code zero. Optional processImage
configuration now binds the existing shared processor in the native subclass.
The SDK keeps image normalization, options, hints and its default processor.
Durable still provides the encoding loop; no second WASM is added.

After the image binding fix, the session/tool set again passes 15 tests with
107 assertions, the bundle set passes all 26 tests with 103 assertions, and both
type checks pass. The earlier 43-test recovery set is not rerun for this image
binding change. A further fresh HOME/cache frozen install verifies all 64 output
hashes, strict public processImage types, the 15 session/tool tests and the image
test with build dependencies unavailable. Its lockfile stays unchanged. Full
runtime, helper and pristine patch checks pass. The source record now covers 62
slice paths, with six records updated for the image fix. The fixed Craft audit
still covers 2,137 files and passes.

A focused independent review finds no confirmed new defect in the image fix.
The reviewer reruns the relocated image test: one pass, zero failures and three
assertions. Eleven related files match the frozen copy, and all 30 installed
Coding outputs match the manifest hashes. This review covers the image fix; it
does not repeat the full slice review, document checks or complete regression
suite. The AgentSession slice is committed locally as a567bf4. F0 through F6
and the remaining source replacements stay open. Real services, Windows and complete
repository/product acceptance are not checked by this slice. The earlier custom
AuthContext gap remains in the ModelRuntime record. Receipts are in the
agent-session-sdk, agent-session-hoisted and agent-session-final-hoisted task
directories.

## Extension runner, plugin types and exec SDK boundary after 0c69e9f

Production uses the published ExtensionRunner, plugin types, defineTool and
execCommand. Three local implementations, two forwards and the old runner
conversion script are deleted: six files and 4,101 lines. Generated source
traversal stops at the SDK modules. The tool wrapper retains replay and host
execution metadata; this slice does not replace that wrapper.

The runner patch adds optional theme and prompt dependencies per instance. The
SDK keeps its event dispatch, error handling and lifecycle algorithms. The
legacy wrapper supplies the headless theme and host documentation prompt; Native
AgentSession supplies its existing prompt builder. The default SDK constructor
keeps its original theme and documentation paths. Only the plugin type
declaration gains optional replay: safe or never. The root exports existing
runner, types and exec modules, with an explicit KeybindingsManager value export.
Plugin types and exec runtime JS are unchanged. No task or checkpoint version
changes.

The affected 16-file set passes 161 tests with 831 assertions. Coding and server
type checks pass. Coverage includes public SDK identity, legacy type consumers,
replay type rejection, instance theme and UI reset, prompt mutation and forced
prompts, handler errors, default SDK paths, plugin loading, resource trust,
codemode and command execution. The SDK-only command tests cover UTF-8 stdout
and stderr, byte caps and cancellation through local child processes.

The first runtime generation stops at the CLI helper guard. Its ExtensionFlag
import has moved to the SDK root, which also supplies imports that must remain.
The guard now removes only that type import and keeps its uniqueness checks.
The initial incremental patch install lacks nested pi-ai 1.5.0 and causes import
and type failures. A normal frozen install restores the declared dependency;
there is no force, node_modules deletion, manifest change or lock change.
The new root type exports also hide the KeybindingsManager value behind a type
export. An explicit value export fixes that conflict in JS and declarations.

One focused test then detects that the Native session uses SDK documentation
paths instead of its existing local paths. The production constructor and test
fixture now inject the existing Native prompt builder. A later temporary type
consumer pulls the complete Native root into declaration output and fails on
an unrelated inferred bug-report type. That consumer now imports ToolDefinition
from the public SDK package root, which is the intended type boundary. Production
type checks and the separate fresh public consumer both pass.

The complete worker bundle run passes 25 tests; the native image test takes
5,764.31 ms and exceeds its default 5-second limit. That test passes alone with
a 15-second budget, three assertions and a duration of 4.95 seconds. Repository
timeouts are unchanged. This is not one complete green 26-test run.

Complete runtime, auxiliary and pristine patch checks pass: 157 runtime TypeScript
files, including 153 under src/pi and four facades, four assets, nine auxiliary
sources and 18 forwards. Coding has 24 physical patch outputs, core four and
durable 30, for a total of 58. Source registration updates or deletes 80 slice
paths, removes six deleted records and adds the policy and SDK-only test. The
fixed Craft v0.15.6 audit passes for 2,150 files.

A fresh hoisted frozen install covers 11 workspaces with a separate HOME and
cache, the public registry and scripts disabled. The lockfile stays unchanged.
All 58 outputs match the tested installation; all 24 Coding outputs also match
CODING-PATCH.json. The unchanged SDK-only runner test file passes offline with
no command lookup: three tests and 24 assertions. A strict public TypeScript
consumer verifies runner dependencies, the KeybindingsManager value, trigger
types and both accepted replay values, and rejects an unsupported replay value.

The first independent review ends with a connection timeout and no final
conclusion. A new read-only review finds no confirmed new defect relative to
0c69e9f. It passes 105 tests, 424 assertions, source type checking and public
package declaration checks. It checks instance theme/UI/prompt isolation,
UI event ownership, continued dispatch after errors, subscription cleanup,
stale contexts, initial and reloaded Native prompts, replay through the tool
wrappers and host bridge, durable permissions and cancellation, and exec error
and output limits. Normalized pristine runner, types, exec and child-process
algorithms match the pinned upstream. All 24 installed Coding output hashes
match. Runtime/helper generation checks pass, 403 source/script/test paths have
no import to the six deleted files, and 74 existing changed files have valid
source records. The six deleted files have no remaining source record. The
review does not repeat document checks, frozen installation, worker/image tests,
full regression or Windows checks. Receipts are in the extension-runner-sdk,
extension-runner-hoisted and sdk-runner-review task directories. AgentSession
production lifecycle, atomic input admission, cancellation and cold recovery
remain open, as do the remaining source replacements. The earlier AuthContext
gap remains recorded in the ModelRuntime section. Real services, Windows, full
repository checks and complete product acceptance were not run for this slice.

## ModelRuntime SDK boundary after 2ac3808

Production now uses the published Coding ModelRuntime class, model configuration,
provider composition, virtual routing, credentials and model stores. Nine local
runtime files, the obsolete conversion script and one composer forward are
deleted, with 2,986 lines in total. Source traversal stops at these SDK modules.
The legacy NativeModelRegistry still provides its structural host adapter.

The SDK patch adds createCredentials and bind entry points. A bound runtime reads
the current host Models and tracks provider replacement, keeps extension overlays
in its own memory collection, invalidates checks for a replaced host, and sends
host catalog refreshes through their original collection and store. Shared
runtime keys stay in memory. Composition, registration, virtual routing,
credential serialization and request algorithms remain in the SDK. The default
create path remains available. The composer runtime JS is unchanged; its
parameter declaration requires only getProvider. No task or checkpoint changes.

The affected 13-file set passes 142 tests with 548 assertions. Coding and server
type checks pass. Tests cover collection and provider replacement, native and
virtual overlays, current-model routing, shared keys, stored credential changes,
failed and cancelled operations, OAuth, stale checks and refresh ownership.
The first attempts fail because the incremental patch installation lacks the
Coding SDK's nested pi-ai 1.5.0. The manifest and lock already require that version.
A normal frozen install restores it without deleting node_modules, using force,
or changing the manifest or lock. Types and affected tests then pass.

The complete worker bundle run passes 25 tests; the native image test exceeds
its default 5-second limit. That test passes alone with a 15-second budget and
three assertions. The repository timeout is unchanged. All 26 scenarios have
passing records, but this is not one complete green run.

Complete runtime, auxiliary and pristine patch checks pass: 160 runtime TypeScript
files, including 156 under src/pi and four facades, four assets, nine auxiliary
sources and 20 forwards. Coding has 21 physical patch outputs, core four and
durable 30, for a total of 55. The source manifest updates 43 changed or deleted
paths, removes all 11 deleted records and adds the new policy. The fixed Craft
v0.15.6 audit passes for 2,154 files.

A fresh hoisted frozen install covers 11 workspaces with a separate HOME and
cache, the public registry and scripts disabled. The lockfile stays unchanged.
All 55 outputs match the tested installation, and all 21 Coding outputs match
CODING-PATCH.json. The consumer runs the same host model test file offline with
no command lookup: 12 tests and 108 assertions pass.

Independent review finds no confirmed regression relative to 2ac3808. Its four
focused files pass 24 tests. Additional deterministic probes cover replacement
without an intermediate read, late credential checks, host catalog publication,
extension store isolation and default SDK configuration. The review compares
85 class members, checks the removed implementations against the pristine SDK,
rebuilds the patch and verifies all 21 installed outputs. The public consumer
type probe passes with the project setting skipLibCheck: true. No complete SDK
algorithm was moved into the patch.

The review reproduces an existing binding gap: the internal collection does not
inherit a custom host AuthContext. If a provider requires values from that
context and the shared store is empty, the host can authenticate while the bound
runtime cannot. The implementation before this replacement has the same gap.
No current production caller supplies that custom context. This slice records
the gap and does not fix it; it does not establish support for that combination.

Receipts are in the model-runtime-sdk task directory; fresh installation and
consumer logs are in the model-runtime-hoisted directory. The independent review
does not cover the six documentation updates or source registration. Plugin
runner/types and the SDK AgentSession production lifecycle, atomic admission,
cancellation and cold recovery remain open. Real services, Windows, full
repository checks and complete product acceptance were not run for this slice.

## Plugin loader SDK boundary after 354f3cb

Both native and legacy loaders now use the published Coding SDK for runtime
creation, API registration transactions, factory initialization, rollback,
factory caching, batch loading and discovery. The host only binds its two module
tables, Jiti/static transformation and directory policy. A narrow SDK patch adds
optional importModule and projectConfigDir options. Caches are scoped by stable
importer identity. Existing cwd/generation invalidation and the default SDK Jiti
branch remain in place. A late import cannot repopulate an invalid cache.

Seven local files are deleted, with 1,179 lines in total: both complete loaders,
the Jiti helpers, the unused manifest helper and forward, and the former resource
wrapper. Source traversal stops at the loader boundary. The native virtual-module
table remains an explicit generated entry because the host still imports it.
Legacy loading still requires agentDir and refuses unavailable Agent execution
and unsupported runtime subpaths. No task version, dependency or checkpoint
format changes.

The affected ten-file set passes 78 tests with 543 assertions. It covers default
SDK loading, shared importer identity, separate host caches, clear/cwd/late-import
invalidation, diagnostics, factory rollback, stale APIs, both Pi and TypeBox names,
per-file import.meta, stack formatters, resource trust and reload. Coding and
server type checks pass. Worker bundle tests pass 26 tests with 103 assertions.
The initial incremental install again lacks the nested Coding pi-ai 1.5.0 and
fails imports and branded types. A normal frozen install restores dependencies;
no functional workaround is added. One new assertion incorrectly expects the
local native root to export loadExtensionFromFactory. That root never exported
it; the assertion is removed, while adapter-level SDK identity checks remain.

Complete runtime, auxiliary and pristine patch checks pass: 169 runtime TypeScript
files, including 165 under src/pi and four facades, four assets, nine auxiliary
sources and 21 forwards. The Coding patch has 18 physical outputs, core four and
durable 30, for a total of 52. A fresh hoisted frozen install covers 11 workspaces
and 1,421 packages with task HOME/cache, the public registry and scripts disabled.
The lockfile stays unchanged. All 52 outputs match the tested installation and
all 18 Coding outputs match CODING-PATCH.json. Offline SDK probes pass for default
loading, importer cache identity/isolation, host discovery, stale APIs and failed
factory rollback. The first smoke check incorrectly expects clearExtensionCache
to reset Bun native module state. The pristine SDK also returns the sequence
1, 2, 3 across that clear. The corrected probe reuses the completed install.

Independent review against 354f3cb confirms one source-manifest defect: all seven
deleted files still had mkOnly records. The main thread removes them and updates
31 added, changed or deleted source records. The complete audit against the fixed
Craft v0.15.6 copy then passes for 2,164 files. The reviewer finds no reproducible
plugin runtime regression. Eleven isolated probe groups pass, covering default
and both host loaders, aliases, cache invalidation, registration transactions,
directory guards, diagnostics and resource trust/reload. The independent pristine
patch check also passes for all 18 Coding outputs. The review does not repeat
full types, builds or the fresh install.

Receipts are in the plugin-sdk task directory. Independent probes and results
are in the loader-review task directory. ModelRuntime, plugin runner/types and
the SDK AgentSession production lifecycle, atomic admission, cancellation and
cold recovery remain open. Real services, Windows, full repository checks and
complete product acceptance were not run for this slice.

## ResourceLoader SDK boundary after df732f7

All three native resource construction paths now use the published Coding SDK
DefaultResourceLoader. The host injects four existing extension-loader functions
so module resolution and plugin transformation keep their existing contracts.
The SDK defaults to its own extension loader. Resource discovery, package
resolution, trust stages, reload, metadata and collisions remain SDK algorithms.
A narrow patch adds missing-package and package-policy options, extra package
sources, prompt paths resolved after trust, and a project-context trust guard.
It also exports the existing prompt-deduplication method without copying it.

The 1,226-line resource loader, 104-line context helper and 31-line prompt
collision helper are deleted, together with their obsolete source-port rules.
Before deletion, all 13 declarations and 7,354 execution tokens match after
normalizing injected extension bindings and the existing local deduplication
delegate. The remaining plugin loader is still local and needs SDK replacement;
this comparison does not establish that its complete implementation is required.

The affected nine-file set passes 70 tests with 423 assertions. It covers
host-only isolation, project trust, SYSTEM/APPEND selection, installed and missing
packages, resource metadata, plugins, module aliases, transformation and reload.
Coding declarations and server typecheck pass. The first incremental dependency
install removes the nested Coding pi-ai 1.5.0 installation. This causes missing
compat-schema imports and incompatible branded types. A normal frozen install
restores six dependencies; both type checks and the affected tests pass without
a functional code change. Worker bundle tests pass 26 tests with 103 assertions.
The first source-generation chain was killed by a one-second task deadline;
the complete chain then passes with a corrected deadline.

Complete source and pristine patch checks pass for 173 runtime TypeScript files,
including 169 under src/pi and four facades, four assets, 10 auxiliary sources
and 22 forwards. The Coding patch has 16 physical outputs, core four and durable
30, for a total of 50. A fresh hoisted frozen install uses task HOME/cache,
the public registry and disabled scripts. It covers 11 workspaces, leaves the
lockfile unchanged and matches all 50 outputs to the tested installation. All
16 Coding outputs match CODING-PATCH.json. Fresh SDK probes pass for trust
acceptance and revocation, prompt paths, missing-source skips, a single inline
factory per reload, context isolation, prompt collisions and injected extension
bindings. The fixed Craft v0.15.6 audit passes for 2,166 files after 25 source
records are updated, added or deleted.

Independent review against df732f7 found no confirmed new correctness or
compatibility defect. Its source audit confirms all 13 resource declarations;
separate probes cover the SDK default and all three host creation paths, trust
acceptance and revocation, one inline factory per reload, prompt/context fallback,
skips without network or subprocesses, reload, stale APIs, factory rollback and
both Pi and TypeBox package names. All probes exit zero. The reviewer did not
repeat full tests, builds or the fresh install.

The review also confirms that 10 declarations in the local plugin loader match
the pristine SDK, including runtime creation, registration, factory initialization
and caching. Its host differences concern module resolution and transformation.
A narrow module-import hook is the next reuse candidate; retaining the complete
plugin loader is not justified by those differences. The SDK AgentSession
production lifecycle, atomic input admission, cancellation and cold recovery
remain open, along with ModelRuntime and plugin loading. Task receipts are in
the resources-sdk task directory; independent probes are in the resource-review
task directory. These checks do not cover real services, Windows or complete
product acceptance.

## SessionManager SDK boundary after 4cc709a

Production session consumers now use the published Coding SDK SessionManager
and session contracts. The 2,057-line local implementation and its source-port
conversion branch are deleted. The SDK patch adds optional context selection,
entry projection and finalization callbacks, a protected constructor, and legacy
subclass factory, directory and app-name hooks. Parsing, migration, tree and
persistence algorithms remain in the published package. The legacy adapter keeps
its durable projection and explicit-directory guards outside the SDK.

Before deletion, the complete patched execution matches all 9,047 tokens of the
local implementation after module-extension normalization. Independent review
also compares the 1,765 public declaration tokens. It confirms all 14 runtime
and 39 declaration exports from the SDK root, without conflicts with existing
explicit exports. The legacy root export keeps the original session contracts;
no actual compatibility issue is found for existing consumers.

The affected eleven-file set passes 112 tests with 680 assertions. It covers
legacy and detached factories, historical JSONL, durable projections, context
edits, session journals, transactions, resources and plugins. Coding declarations
and server typecheck pass. The initial declaration run overlaps dependency
installation and reports incompatible pi-ai class identities. After installation
finishes, both type checks pass without a code change. Worker bundle tests pass
26 tests with 103 assertions. Complete source and pristine patch rebuild checks
pass for 174 runtime TypeScript files, including 170 under src/pi and four
facades, four assets, 12 auxiliary sources and 22 forwards. The Coding patch has
14 physical outputs, core four and durable 30, for a total of 48.

A fresh hoisted frozen install uses task HOME/cache, the public registry and
disabled scripts. It installs 1,421 packages for 11 workspaces, leaves the lockfile
unchanged and matches all 48 patched outputs to the tested installation. All
14 Coding outputs match CODING-PATCH.json. The fresh SDK reports version 1.5.0.
Its probes cover session factories, directory hooks, file persistence, projection
callbacks and append failure rollback. The fixed Craft v0.15.6 audit passes for
2,167 files after 41 source records are updated, added or deleted.

Independent review against 4cc709a finds no confirmed defect. Targeted probes
cover projection defaults and fallback, double compaction, context edits and a
real EEXIST failure on the first file write. The existing file stays intact,
entries and leaf roll back, and a later successful append retains the parent
chain when reopened. The review checks source traversal cutoff and targeted
residual imports. It does not repeat the complete tests, builds, bundle or fresh
install, and does not validate real services or cross-platform behavior.

This replaces SessionManager storage and projection contracts only. The SDK
AgentSession production lifecycle, atomic input admission, cancellation and cold
recovery remain open, along with ModelRuntime and resource loading. Task
receipts are in the session-sdk task directory.

## Model and MCP registry SDK boundary after 05d63dc

ModelRegistry and the complete MCP server module now use the published Coding
SDK. The root patch exports both existing modules. A declaration-only change
accepts Pick<ModelRuntime, keyof ModelRuntime> in the registry constructor, which
uses public runtime operations. The registry JavaScript is unchanged. Before
deletion, full execution-token comparisons match all 809 tokens of ModelRegistry
and 1,675 tokens of the MCP module after normalization of module extensions.

The two local implementations, 244 and 358 lines, and the unused two-line MCP
forward are deleted. The legacy facade keeps its structural constructor and
extends the SDK class. It does not copy registry methods. Production consumers,
OAuth types and source traversal now use the SDK boundary. This replaces the
facades only; the host-bound ModelRuntime, resource loader and session migration
remain open.

The affected ten-file regression set passes 66 tests with 454 assertions.
Coding declarations, server typecheck and 26 worker bundle tests with 103
assertions pass. Complete source checks cover 175 runtime TypeScript files,
including 171 under src/pi and four facades, four assets, 12 auxiliary sources
and 22 forwards. An initial generator command uses unsupported --write and
fails before generation; the default write mode then succeeds. Pristine Coding
patch rebuild check also passes. The Coding patch has 12 physical outputs; the
only added file is the registry constructor declaration. Core remains four and
durable remains 30, for a total of 46.

A fresh hoisted frozen install uses task HOME/cache, the public registry and
disabled scripts. It installs 1,421 packages for 11 workspaces and leaves the
lockfile unchanged. All 46 patched outputs match the tested installation and
the 12 Coding outputs match CODING-PATCH.json. From the fresh Coding workspace,
the SDK reports version 1.5.0. Its ModelRegistry consumes the existing host-bound
ModelRuntime, follows host replacement and resolves synthetic anonymous auth.
MCP probes check config validation, alias normalization, namespace, replacement,
owner-only unregister and cloned list configuration. No model request, MCP
process or external connection is started.

The fixed Craft v0.15.6 source audit passes for 2,167 files after 27 source
records are updated or deleted, including the three removed files. Independent
review against 05d63dc finds no confirmed correctness or compatibility defect.
It checks 21 type and runtime exports, including 13 identical runtime bindings,
positive and negative constructor type probes, legacy declarations, MCP owner
and namespace protection, config copies and notifications. It also checks the
source traversal cutoff, deleted files and absence of copied implementations in
the patch. The review uses the existing full execution-token comparison record.

The review does not repeat the complete tests, builds or patch rebuild checks.
An additional repository-wide residual search times out and is stopped; the
review conclusion covers the listed targeted checks. These checks do not
validate the future production SDK session's persistence, atomic input
admission, cancellation or cold recovery. Task receipts are in the registry-sdk
task directory.

## Theme and keybinding SDK boundary after e20bb1a

Theme and KeybindingsManager now use the public Coding SDK. The patch exports
existing theme and keybinding contracts, enables the existing full theme
validator by default and locates coding-assets/theme beside a worker bundle.
It does not copy the theme, highlighting or keybinding algorithms. The root
declaration removes a conflicting type-only KeybindingsManager export so the
published class is available as both a value and a type.

Nine local TypeScript files, two theme JSON files and the old theme conversion
script are deleted. The direct highlight.js dependency is removed. The SDK can
still use it transitively. The worker copies theme JSON from the SDK. Its asset
filter preserves the required HTML template and vendor JavaScript. Complete
source checks pass for 177 runtime TypeScript files, including 173 under src/pi
and four facades, four assets, 12 auxiliary sources and 23 forwards.

Before deletion, a baseline records all 56 resolved colors and ANSI results for
dark, light and three system theme settings. Comparison against the SDK passes.
All 90 keybinding definitions, legacy name migration and effective custom
configuration also match. Behavioral checks retain foreground/background slot
errors, five fallbacks, explicit zero, variable errors, complete file validation,
HTML colors and shared plugin theme state.

The final focused run passes 72 tests across nine files with 363 assertions.
Coding declarations, server typecheck and 26 worker bundle tests with 103
assertions pass. Checks use task-only HOME and configuration. Initial declaration
checks find an obsolete highlight reference and the conflicting type-only export;
both are corrected. Three patch installs leave the existing hoisted layout without
the SDK's nested pi-ai 1.5.0. Ordinary frozen install restores the dependencies;
final imports, comparison, types and bundle checks pass without force or deletion.

A fresh hoisted frozen install uses new HOME/cache, the public registry and
disabled scripts. It installs 1,421 packages for 11 workspaces and leaves the
lockfile unchanged. All 45 patched physical outputs, core four, Coding eleven and
durable 30, match the tested installation. The eleven Coding outputs also match
CODING-PATCH.json. Rebuild check from the pristine release passes. Actual workspace
imports and a relocated bundle load both themes, reject an invalid color through
the full schema and use the 90 keybinding definitions. The first relocation
assertion compares macOS /var and /private/var spellings; realpath comparison
corrects the probe, and checks pass using the same installation.

The fixed Craft v0.15.6 source audit passes for 2,170 files. Punctuation checks
pass for six documents, all 105 relative link targets exist and diff checks pass.
Independent review finds no confirmed functional defect. Its additional isolated
probes verify both plugin aliases, Theme identity and singleton updates, BOM and
legacy key migration, precedence, disabled and invalid bindings, reload and broken
JSON fallback. Relocated themes retain 56 colors and the HTML template and all
three vendor scripts remain present. The schema module's JS and declaration
headers still describe optional validation; both comments are corrected through
the patch generator. These two comment-only outputs account for the increase
from nine to eleven Coding patch files. The final fresh install and patch rebuild
checks include them. The reviewer does not repeat the full test suite or cover
Windows/WSL, compiled Bun binaries or real terminal watchers. Review receipts are
in the presentation-review task directory; main-thread receipts are in the
presentation-sdk task directory. Resource loader, model registry and session replacement remain open;
these checks do not validate the future production session's atomic input,
cancellation or cold recovery.

## Package manager SDK boundary after 2c2b98a

Host package commands, resource discovery and the legacy package adapter now use
the published DefaultPackageManager. The Coding patch adds host discovery
policy, project directory, update scope, protocol output and installer drain
options. It exports the existing package contracts from the public root and
narrows settings to the six methods the manager uses. Settings algorithms are
unchanged. The six patched Coding outputs have matching installed hashes.

Before deletion, an AST comparison checks all 140 module functions, constants
and class methods against the patched published implementation. The constructor
is checked separately for directory and policy initialization. The 2,940-line
local package manager is deleted. Its output guard and Git helper leave the
runtime closure and have no remaining consumers; both implementations and their
two legacy forwards are deleted. Direct semver, hosted-git-info and the latter's
type dependency are removed. The SDK can still use these transitively.
Complete generator checks pass for 186 runtime TypeScript files, including 182
under src/pi and four facades, six assets, 12 auxiliary sources and 23 forwards.
The old package-manager source-port conversion is also removed.

The final focused run passes 51 tests across seven files with 308 assertions
and no failures. Coding declarations, server typecheck and all 26 worker bundle
tests with 103 assertions pass. Coverage includes SDK class identity, directory
and offline policy, explicit commands, project trust, host-only isolation and
resource reload. Checks use task-only HOME, configuration and allowlist
environments. They do not call a real provider or install a real package.

Initial checks expose and correct four validation issues. The patch generator
first rejects a nonunique replacement anchor; the anchor now includes its
following declaration. A bare TypeScript scanner misreads template literals;
AST leaf-token comparison then passes without changing production algorithms.
One focused assertion incorrectly assumes the compatibility root exports
DefaultPackageManager; it is removed without widening that root. Complete
source check detects the unused output guard; checking its consumers also
identifies the Git helper, and both are deleted instead of added to the closure.
The final focused and source checks pass after these corrections.

A fresh hoisted frozen install uses new HOME/cache, the public registry and
disabled scripts. It installs 1,421 packages for 11 workspaces and leaves the
lockfile unchanged. Imports from the actual Coding workspace verify settings
exports, merge, trust, offline missing-source callbacks and skip diagnostics.
All 40 patched physical outputs, core four, Coding six and durable 30, match the
tested installation. The six Coding outputs also match CODING-PATCH.json.
Rebuild check from the pristine release passes.

The fixed Craft v0.15.6 source audit passes for 2,182 files. All six changed
current documents pass punctuation checks, all 105 relative link targets exist,
and diff checks pass. Historical settings counts remain in their section.

Independent read-only review finds no confirmed defect in this slice. It checks
root exports, class identity, structural settings, native and legacy project
directories, callback and diagnostic policy, update scope/trust, installer drain
and shutdown ownership. Additional isolated probes confirm SDK identity through
the extension loader and structured project package paths and filters in both
native `.tau` and legacy `.pi` directories. The review does not repeat the main
tests or cover real network installation, Windows, source audit or the full
session migration. Receipts are in the package-sdk task directory. Production
session replacement, atomic input persistence and cold recovery remain open.

## Settings SDK boundary after 137d6de

The settings slice uses the published SettingsManager, storage classes, types,
defaults and merge implementation. The public root does not expose all existing
settings contracts, and deepMergeSettings is not exported. A four-file Coding
SDK patch adds these exports and declarations. It changes no settings algorithm,
lock or lifecycle. The rebuild script and CODING-PATCH.json record the original
and output hashes. Rebuild check and all four installed output hashes pass.

Before deletion, a comparison confirms matching runtime tokens for the local
manager, schema and defaults and the patched published modules. All 22 relative
consumer imports move to the public root. The generators stop at the settings
boundary and remove the old local merge-export conversion. Three local files,
2,017 lines in total, are deleted. Complete checks for both generators pass:
189 runtime TypeScript files, including 185 under src/pi and four facades, six
assets, 12 auxiliary source files and 25 shared forwards. This does not close the
remaining source-removal work.

The final focused run passes 34 tests across five files with 245 assertions and
no failures. It covers published SettingsManager identity, host-only and
untrusted-project isolation, profile settings, custom storage, reload/flush,
compaction policy, legacy merge and types, and explicit package commands.
Coding build:types and the server typecheck pass. All 26 worker bundle tests
pass with 103 assertions. Checks use task-only HOME and configuration data.

The initial focused and bundle runs fail because the existing hoisted Coding
SDK resolves pi-ai 1.1.0 and cannot load its required schema exports. A fresh
hoisted frozen install resolves its declared pi-ai 1.5.0 correctly. A normal
frozen install check adds six missing dependencies to the existing layout,
without force, removal or lockfile changes; focused and bundle checks then
pass. The fresh-install probe first fails an incorrect assertion that merge
resolves `+bash` immediately. The implementation preserves that modifier for
the tool-selection step. Correcting the probe to the existing contract passes
without reinstalling dependencies or changing production code.

The new frozen install uses the project's hoisted linker, fresh HOME/cache,
the public registry and disabled scripts. It installs 1,422 packages for 11
workspaces and leaves the lockfile unchanged. Actual Coding workspace imports
verify settings exports, merge and trust. All 38 patched physical outputs,
core four, Coding four and durable 30, match the tested installation. The four
Coding outputs also match their manifest. The earlier 2,826-package check
omitted bunfig.toml and did not verify the project's hoisted layout; its older
scope remains recorded below.

The fixed Craft v0.15.6 audit passes for 2,186 files after the source records are
updated. All six changed current documents pass punctuation checks, and all
105 relative link targets exist. Diff checks pass. Independent review finds one
maintenance-script defect: Git diff.context changes generated patch hunks.
The script now sets --unified=3; checks pass with default Git configuration and
with diff.context=0. The review finds no confirmed runtime regression and checks
profile isolation, trust changes during queued writes, custom-storage merge,
flush/drainErrors delivery, legacy merge, declarations and generator boundaries.
The reviewer reports one automatic skill fork despite the no-subagent brief;
that run has ended, and the reviewer directly verifies the reported evidence.
The review does not repeat focused/types/bundle, fresh installation or platform
checks. Receipts are in the settings-sdk task directory. Production session
replacement, atomic input persistence and cold recovery remain open.

## Public Coding SDK boundary after e2213c8

On 2026-11-09, the user approved the public pi-coding-agent SDK as a production
dependency, while durable remains the execution base and the original CLI is
not started. This replaces the earlier whole-package dependency restriction.
The earlier F0 through F6 acceptance was too broad: source inventories and
maintenance entries did not meet the goal of removing unnecessary Coding
source copies. The current follow-up list reopens those tasks.

The first replacement pins @earendil-works/pi-coding-agent to 1.5.0. Event bus,
diagnostic types, frontmatter and the file mutation queue now use its public
root exports. Four implementation files and three legacy forwards are deleted.
Both generators stop at these SDK contracts. The package no longer has a direct
YAML dependency; the SDK still has a transitive YAML dependency. No Coding SDK
patch or private subpath import is added. The runtime inventory now records
192 TypeScript files, including 188 under src/pi and four facades, plus six
assets. This is a first slice, not completion of the source-removal goal.

The focused run passes 90 tests across six files with no failures. It covers
published implementation identity, generation boundaries, extensions, host
resources, plugin transformation and scoped source checks. Coding build:types
and all 26 worker bundle tests pass. Complete runtime source check passes.
The fixed independent Craft v0.15.6 audit passes for 2,186 audited files after
source records are updated. These results do not validate a new production
AgentSession path.

A separate deterministic probe combines the public AgentSession constructor
with the existing durable Agent. A plugin command and handled input cause no
model request. A transformed input produces one local response; the SDK
session and Harness both contain system, user and assistant messages, and no
tasks or reports remain. The session uses the exact supplied Agent instance.
This proves that the public constructor can run that combination. It does not
validate cold recovery, tool effects, atomic journal delivery or accepted-input
persistence. The probe uses task-only data and no real provider.

A fresh HOME and dependency cache install all 11 workspaces from the public
registry with frozen lockfile and scripts disabled. Bun reports 2,826 packages
installed, and the lockfile remains unchanged. The first verification script
then fails because it imports the SDK from the temporary project root, which
does not declare that dependency. Verification resumes from the actual Coding
workspace without reinstalling packages. Public SDK version, event bus and
frontmatter checks pass; all 34 core/durable patch outputs match the tested
installation. This install does not build the product or exercise recovery.

An independent review of this slice finds no confirmed defect. It checks the
public exports, both generators, all changed imports, seven deleted files and
dependency records. An in-memory check confirms that SDK queue calls and the
remaining local edit/write tools serialize together and release after failure.
All 210 records across the two source manifests match disk hashes. The reviewer
also runs the two boundary tests successfully, but does not repeat the focused,
types, bundle or complete source checks. This review does not accept the full
source-removal goal.

The current dependency and acceptance statements are corrected in 22 Markdown
files. All 287 relative link targets exist. Punctuation checks pass for the seven
current Coding documents in full and for the changed text in the other files.
Full checks on those older documents report existing punctuation issues outside
this slice; those results are not recorded as full-document passes. The fixed
Craft audit passes again after both root README source records are updated.

Receipts use the sdk-elimination task directory, with focused, types, bundle,
source and frozen-result records. The production Coding session, resource,
model and UI implementations still require replacement and verification.

## Theme contract and complete source after 6240ed9

The user requested a permission correction before the loop resumed. A project
allow cannot override a global deny. After an exclusive backup, the global
settings add this exact relative-path exception immediately after the existing
Read token rule, in the same deny array:

```json
"Read(*token*)",
"Read(!packages/pi-durable-coding/src/pi/modes/interactive/theme/theme-tokens.ts)"
```

Normal Read calls then succeed for the local theme source and its pinned Pi
checkout source. The remaining configuration matches the backup. A separate
synthetic token-named write in the repository is rejected and creates no file.
The exception matches relative to the working directory, so the same complete
relative path in another project can also match. It does not remove the other
token or credential rules. The first `!./packages/...` attempt remained blocked;
this check does not establish whether syntax or configuration refresh caused
that result. No alternative reader was used to bypass an effective denial.
The earlier sections retain the failed project-only attempt at its own time.

The complete table has 56 names: 49 foreground and seven background tokens.
The five optional fallbacks are scrollbarTrack to muted, scrollbarThumb to
text, searchMatchBg to selectedBg, searchMatchText to text, and thinkingMax to
thinkingXhigh. They define the public Theme types, slot checks, schema,
terminal-default colors and HTML output. Published pi-tui supplies color
primitives but does not supply this Coding theme contract. The table remains.

A regression first reproduces incomplete themes being accepted by the actual
host resource loader. No retained caller installs the optional CLI validator.
File parsing now calls the existing validateThemeJson directly, without a new
dependency. The obsolete optional-validator API and its inaccurate main.ts
installation comment are removed. Tests cover all slots, missing required
colors, optional fallbacks, zero and empty-string values, variable chains and
cycles, invalid fields and resource diagnostics.

No retained caller or package-root export uses terminal color-report setters.
Their state always had no report. The port removes that state and the unused
adaptive solver; system-theme.ts shrinks from 655 to 123 lines. Indexed colors,
dim tokens, terminal-default backgrounds, COLORFGBG, dark fallback and custom
themes remain. Dark and light results match SHA-256 values captured before the
port. Real session HTML checks theme variables, export background overrides,
escaping and distinct collapsed/expanded tool results. This scope removal is
not additional released SDK coverage and changes no task or document version.

The first complete source check exits 1 at the inventory comparison. Complete
write generation identifies one obsolete record: core/tools/renderers/index.ts.
It has no retained caller or package-root export and lies outside the generated
closure. The file and its records are removed; individual renderers remain.
Complete check now also rejects residual TypeScript outside the generated
closure. Scoped check keeps its previous limited semantics. Full generation
and the final complete check pass with 196 TypeScript outputs, including 192
under src/pi and four facades, plus six assets. The theme transforms run before
dependency traversal and reject changed pinned declaration boundaries.

The first fixed Craft audit reports five source-record problems. README.md,
README.zh.md and the server-core README already contain committed architecture
corrections; bun.lock already removes the unused private Mermaid dependency.
The runtime inventory also has a stale hash. Git history was checked before
updating those records. The theme slice adds only its own source records and
removes the unused renderer entry. The full audit against the independent
Craft v0.15.6 checkout at 8df01c5d0ac73c35add5954e6f190ce038d35845 then exits 0
and covers 2,191 files. The real Craft directory is not accessed.

The first three focused commands each pass 82 tests and fail one new HTML
fixture. The fixes preserve the built-in variables, expect the existing RGB
CSS format, and give the collapsed/expanded renderers distinct text. The last
failure exposed the renderer's existing deduplication when both views match;
no renderer behavior was changed for the fixture. The final focused command
passes all 83 tests across four files. Coding build:types, the separate symlink
declaration consumer and all 26 worker bundle tests also pass. That consumer
is not a new frozen installation. The previous workspace frozen install and
34 patch-output checks remain valid because their inputs have not changed.

The complete repository test entry exits 0 in 546 seconds. The main batch
passes 6,880 tests, skips 11 and reports no failures across 489 files. The
subsequent 36 batches pass another 301 tests. validate:ci exits 0 in 107 seconds.
A later diff check finds one extra final blank line in generated system-theme.ts.
The generator and output are corrected together, leaving 123 lines. Focused
checks and complete source check pass again; source hashes are updated. This
whitespace-only correction does not require another full test or CI run.

An independent static review against 6240ed9 finds no confirmed new defect or
missing public contract in the theme slice. It checks the token slots,
fallbacks, validation, palette/dim, renderer/HTML boundary, deleted barrel and
four theme output hashes. It does not run tests, builds, full generation or a
real UI. The reviewer invoked a review skill that started one child execution,
contrary to the explicit no-delegation brief. That process deviation is retained
here; its candidate concerned existing baseline behavior and was not reported
as a new defect. Dynamic verification above was performed by the main thread.
A separate final acceptance review confirms that the runtime slices can be
accepted. It identifies two missing maintenance entries, for production
`grep/find/ls` and explicit npm/git package operations, and stale wording that
requires an immediate session/summary replacement without a confirmed plan.
The main thread verifies the actual entry points and adds both entries, with
API gaps, scope, failure and cancellation behavior, exit conditions and upgrade
checks. Existing search, binary-cancellation and host-package-command tests are
included in the complete test run above; no runtime changes or new tests are
needed for these entries. Session/summary adapters remain subject to their
recorded exit conditions. Current F0 through F6 implementation acceptance is
complete after these corrections; historical platform limits remain. The final
review does not re-run product tests or review every historical log line.

The architecture table also corrects two stale retention claims: the private
Mermaid renderer/dependency and terminal status reporter have already been
removed. All six documents pass punctuation checks. The file-link check passes
for 104 local links, and all 11 local heading anchors pass a separate check.
The final git diff check reports no whitespace errors. Atomic commit and push
results are reported from Git at delivery.

One unrelated retained comment in components/bash-execution.ts still names
the deleted tui-renderer.ts helper. This comment is not an execution dependency
and is not changed by the theme port. The old theme-schema comment and the six
current documents' permission, count and full-source claims are corrected in
this slice; dated evidence sections retain their original facts.

Receipts use the theme-* labels under the task directory
mkagent-coding-final-EJ6XD5. Tests use task-only child HOME/configuration,
local fixtures and no inherited provider credentials. No real WebUI, account,
paid model or upload service is used.

## Read permission diagnosis on 2026-11-09

The original reviewer requested the first 35 lines of theme-tokens.ts through
Read. The tool returned: "File is in a directory that is denied by your
permission settings." This confirms a historical tool rejection. It does not
establish a user instruction against reading that source.

A read-only check of the relevant permission fields now finds `Read(*token*)`
in permissions.deny in the global `~/.claude/settings.json`. This pattern
covers the filename theme-tokens.ts. Neither project settings.json nor project
settings.local.json exists. Theme and system-theme callers use these tokens
as terminal color identifiers, not authentication credentials. The check does
not establish who added the rule, when it was added, or whether the same rule
caused the historical rejection. It does not inspect every managed or
session-supplied policy layer. The earlier claim that the historical rejection
alone proved a continuing restriction was too strong.

No configuration was changed, and no read of the target source was retried.
Full theme-table necessity, source generation and Craft audit remain unverified.
The historical checks below keep their original scope and results.

## Project read rule and workspace install after 731728a

The user requested a project Read allow rule for the theme color source.
The new project `.claude/settings.json` contains only:

```json
{
  "permissions": {
    "allow": [
      "Read(/packages/pi-durable-coding/src/pi/modes/interactive/theme/theme-tokens.ts)"
    ]
  }
}
```

The JSON and exact-rule assertions pass. The single leading slash anchors the
path at the project root in this project settings file. No wildcard, write
permission or broader tool permission was added. A normal Read of the first
35 lines still returns: "File is in a directory that is denied by your
permission settings." The rule is present; effective read access is blocked.
The global `Read(*token*)` deny remains unchanged. The [official permission
rules](https://code.claude.com/docs/en/permissions) state that deny takes
precedence over allow across settings sources. Project allow and negation
rules cannot cancel a user-level deny. No alternate reader, copy or delegate
was used to obtain the source. The diagnosis above describes the state before
this project file was created and the Read retry was made.

The project file is absent from the independent Craft v0.15.6 reference at
8df01c5d0ac73c35add5954e6f190ce038d35845. Its MkAgent-only source record has
SHA-256 cd37d93ad05fa4a35ddc647091062e57834a44a9fc375b7f2ce7a26af232931a.
This targeted registration does not constitute a full Craft audit.

The dependency install uses the current 731728a lockfile, all 12 workspace
manifests including the root, and both dependency patches. It runs in a new
fixture directory with a new empty cache, a task-only child HOME and the
public npm registry. No provider credentials or real application configuration
are inherited. The root project node_modules and input files are not changed.
The install command is:

```sh
bun --no-env-file install --frozen-lockfile --ignore-scripts \
  --cache-dir <new-task-cache> --registry https://registry.npmjs.org
```

Bun 1.3.14 exits 0 in 46 seconds and reports 1,420 packages installed. All
11 non-root workspace links resolve to the copied manifests. Both lockfile
copies and all original manifests and patches retain their input hashes.
The install runs with lifecycle scripts disabled and no runtime sources in
the fixture. This result resolves the dependency-install check for this
version; the older offline failures below retain their original scope.

The new installation passes a separate artifact check. Coding and worker each
resolve pi-ai, pi-agent-core and pi-durable 1.5.0 inside the fixture; root
pi-ai remains 1.1.0. All 30 durable patch outputs match DURABLE-PATCH.json, and
the four core patch outputs match the current tested installation. Receipts
are workspace-install-result.json and workspace-install-artifacts-result.json
under the task directory mkagent-coding-final-EJ6XD5. Runtime imports, install
scripts and a full product build were not checked in this fixture.

This slice adds configuration, its source record and documentation only.
The previous slice's runtime tests and CI were not rerun. Full theme-table
necessity, complete source generation and closure recomputation, and full
Craft audit remain open. Project permission changes do not remove these gaps.
The exact configuration and source-record assertions, six document punctuation
checks and 102 local file-link checks pass. The link check does not validate
all anchors; the new evidence heading is checked separately. An independent
static review of this eight-file slice found no confirmed defect. It checked
the scripts, receipts, install log, source entry and document changes without
rerunning product checks or reading the denied source or global settings.

## Private components after 06d1346

The component barrel still brought in FirstTimeSetupComponent,
ScopedModelsSelectorComponent and TrustSelectorComponent. The package root
does not export these classes or their private types, and the package exports
map does not expose their source paths. Focused checks of class names, types,
module paths and whole-barrel imports found no retained caller. The three
implementations and their barrel exports are removed. The generator applies
this exclusion before it walks dependencies and rejects missing or duplicate
upstream export blocks. This removes unused host interfaces; it is not a
released SDK replacement or a guarantee for direct private-file consumers.
Public ModelSelectorComponent, Theme, CustomEditor, renderers and host trust
handling remain.

The focused checks pass 87 tests with 142 expect() calls and no failures across
four files. Coding build:types, a separate symlink declaration consumer and
the 26 worker bundle tests pass. The new generator test checks the retained
plugin export paths and rejects changed removal boundaries. Checks use local
fixtures and temporary data without real provider or account requests.

The source inventory has 197 TypeScript records, including 193 under src/pi,
and six assets. All 192 allowed Coding sources pass the pinned scoped check;
six assets match their source and output hashes, and four facade output hashes
match. Only three source records are removed, and the component barrel's
output hash and transformation record are updated. The Craft override check
removes the same three records, updates four hashes and three reasons, and
confirms that all other runtime and override records match 06d1346. Dependencies,
lockfile and SDK patches are unchanged. This is not full source generation or
a recomputed closure. The denied theme token source is excluded, and
complete:false and closureRecomputed:false remain in the receipt.

The complete repository test entry exits successfully in 563 seconds. Its main
batch passes 6,874 tests, skips 11 and reports no failures across 488 files;
all 35 isolated test files complete. The current-code validate:ci check passes
in 128 seconds. Later documentation edits do not change runtime code.
The independent static review relative to 06d1346 found no confirmed product,
public plugin or document defect in this slice. It checked callers, public and
private export boundaries, the generator exclusion, inventories and the five
focused verification receipts. It did not rerun checks or read the denied
source. The later repository test/CI receipts and permission diagnosis were
outside that review. Direct private-file consumers remain outside the public
contract, and full generation, Craft audit and frozen installation remain open.

The six changed documents pass their punctuation checks; all 99 local file
links resolve. That link check does not check anchors. Earlier results below
apply to their stated versions.

## Private host remnants after 20cb6e8

The caller and export check removes 15 TypeScript files that only served the
excluded launcher and mode hosts: cli/auth-command.ts, core/radius.ts,
core/cache-stats.ts, utils/changelog.ts, utils/version-check.ts,
utils/clipboard-image.ts, interactive/theme/theme-controller.ts, and the
interactive components custom-entry, earendil-announcement, easter-egg-3d.lazy,
easter-egg-3d, mermaid, pi-logo, radius-login-selector and themed-text. The
component barrel and root entry do not export these implementations. Focused
repository searches found only their definitions and private references.
The package does not expose private source subpaths. This evidence excludes
the denied theme token body and cannot prove behavior for arbitrary consumers
of private filesystem paths.

The announcement's clankolas.png resource and the unused grok-mermaid
dependency are removed too. The runtime generator and worker build stop
collecting the upstream interactive assets directory. Source records remove
exactly these 16 targets; the lockfile removes only the unused workspace
requirement and package record. Remaining source records are unchanged.
MkAgent's clipboard and usage functions, public renderers, Theme, CustomEditor,
RPC client/protocol and session lifecycle remain.

The focused tests pass 86 tests with 142 assertions and no failures. Coding
build:types and a separate `./native` declaration consumer pass. The consumer
uses a package symlink rather than a fresh install. The worker bundle tests
pass 26 tests with 103 assertions, including moved assets and offline runtime
behavior. These checks use temporary data and local fixtures, without real
clipboard, authentication, upload or provider requests.

The complete repository test entry exits successfully in 573 seconds. Its main
batch passes 6,873 tests, skips 11 and reports no failures across 488 files;
all 35 isolated test files complete. The current-code validate:ci check also
passes in 122 seconds. Later documentation edits do not change runtime code.

The independent static review relative to 20cb6e8 found no confirmed product
or public plugin defect in the deletion slice. It checked retained exports,
virtual module entries, focused callers, resources and source records. It did
not rerun tests or inspect every line of the animation algorithm, and it did
not read the denied token source. Direct external imports of private files
remain outside the reviewed contract.

The inventory now has 200 TypeScript records, including 196 under src/pi, and
six assets. A scoped generation check passes all 195 allowed src/pi sources
against the pinned upstream checkout. Six assets match both source and output
hashes; the other four facade output hashes match. The check does not expand
imports, regenerate the four facades or read the denied theme token source.
It reports complete:false and closureRecomputed:false. Full generation and
Craft source audit remain open.

A network-denied frozen lockfile-only check failed while Bun tried to resolve
registry metadata for multiple workspace dependencies. No registry request
was allowed. A structural comparison confirms that this slice changes only
the two grok-mermaid lock entries and that all workspace dependency declarations
match their package.json files. These checks alone do not establish a complete
frozen install.

A later comparison uses separate dependency-declaration fixtures for 20cb6e8
and 06d1346, with all 12 workspace manifests, their lockfiles, both patches and
the hoisted install setting. It copies no runtime source. With the same task
cache, network denied and scripts disabled, both lockfile-only frozen checks
exit 1. The baseline reports metadata failures for 96 packages and 06d1346
reports 95; all 95 are shared, with only grok-mermaid removed from the baseline
failures. No new metadata failure appears in 06d1346 under these conditions.
Both fixture lockfiles and the workspace lockfile stay unchanged. This is a
comparison of the observed failures, not a complete workspace install, and it
does not reproduce the workspace preload. A separate
read-only standard-cache attempt also fails because Bun cannot write to its
temporary directory. Full frozen installation remains unverified.

The [SDK maintenance register](coding-sdk-maintenance.md) records released APIs,
the four-file core patch, the 30-file durable patch and the remaining Coding
adapters by capability. It includes API gaps, recovery boundaries, removal
conditions and upgrade checks. The architecture, plan, correction list and
acceptance table link to it. It does not close the denied token-source or full
source checks. The architecture's claim that the private clipboard entry still
calls the MIME helper was stale and is corrected. The unchanged upstream
BashExecutionComponent comment still names the removed tui-renderer.ts host;
that comment is not evidence of a retained caller or a required module.

An independent semantic review found no confirmed issue in the maintenance
register and the five related document changes. It checked the inventories,
patch file groups and test/CI receipts. It did not verify API implementations,
test counts, all source files or the full dependency closure, and it did not
read the denied token body or rerun tests. All six documents pass punctuation
checks and 95 local file-link checks; link anchors are not checked.

## Private terminal helpers after d913008

A focused check of the remaining top-level interactive helpers found no caller
or package-entry export for session-share.ts, chat-viewport.ts, tui-renderer.ts
or program-status-reporter.ts. They compose upstream sharing, viewport,
terminal renderer and status reporting. All four files and their source records
are removed. Existing mode-entry exclusions already cut their dependency path;
no replacement implementation or generator rule is added. Public message/tool
renderers remain. The external editor, model search and catalog refresh helpers
still have component callers and remain.

The plugin transpiler and host UI tests pass 29 tests with 124 assertions and
no failures. They exercise both package aliases, theme styling, custom editor
input, message rendering, reload, cancellation and shutdown. Coding build:types
and a separate `./native` declaration consumer pass. The consumer uses a package
symlink, not a fresh frozen install. Checks use temporary data and local
fixtures without sharing, authentication or real provider requests.

The independent static check relative to d913008 found no confirmed defect in
the deleted-helper boundary, retained entry exports or source-record changes.
It did not rerun tests. Its initial index call returned denied theme-tokens.ts
source despite the requested exclusion. This violated the access restriction.
The reviewer stopped that index path and excluded the returned content from
the conclusion. This incident is not valid evidence for the denied source
check, which remains open. No further index call is used for this slice.

The inventory has 215 TypeScript records, including 211 under src/pi, and seven
assets. The record check confirms that both inventories remove only the four
targets; other entries are unchanged. This is not a recomputed minimal closure
or complete source generation. The denied theme-token check remains open.

One retained BashExecutionComponent comment still attributes binary sanitizing
to tui-renderer.ts executeBashCommand. That helper did not define the named
method. The retained core/bash-executor.ts actually sanitizes binary data
before its onChunk callback. The stale comment is recorded here; this slice
does not change Bash execution or its public renderer.

## Unused terminal bug-report flow after b10b881

A focused caller and export check found no remaining use of the terminal
reportBug flow after the three mode hosts were removed. uploadBugReport was
used only by that flow, and neither function had a public root export. The
terminal consent, delivery UI and upload helper are removed with their two
source records. The existing entry exclusions already prevent traversal into
this host flow. No new generator rule or replacement implementation is added.

AgentSession.summarizeForBugReport, core/bug-report.ts and the durable summary
path remain. The existing host integration test actually calls the summary
method, along with compaction and branch summaries. That test and the plugin
transpiler tests pass 11 tests with 52 assertions and no failures. Both package
aliases still exercise theme, editor and renderer behavior. Coding build:types
also passes. The independent read-only review relative to b10b881 found no
confirmed defect in the two deletions or their source records. It checked the
public entry and retained summary path; behavior checks remained with the
main thread. It did not read the denied theme token file or cover external
consumers of private source paths. All checks use temporary data and
deterministic local fixtures; no upload or real provider request runs.

The retained inventory now has 219 TypeScript records, including 215 under
src/pi, and seven assets. The source-record check confirms that only these two
records are removed and all other inventory/override entries are unchanged.
Its first run used a nonexistent summary.ts path; the check now names the
actual summary-task.ts and summary-binding.ts files and passes. Document links,
punctuation and git diff --check pass. The earlier 221/7 count belongs to the
mode-host slice. This deletion does not claim SDK replacement, a recomputed
minimal closure or complete source generation. The denied theme-token check
remains open.

## Upstream run-mode hosts after 5662422

On 2026-11-09, a focused review compared the original MkAgent integration and
current host wiring with the required plugin contract. MkAgent creates Coding
sessions and owns UI and transport. InteractiveMode, runPrintMode and runRpcMode
are upstream terminal, stdout and stdin/stdout RPC hosts. Their five value/type
exports are excluded from both entry points, and their three implementations
are removed. The generator applies both exclusions before dependency traversal.
This is host-scope removal, not replacement by an official SDK.

RpcClient and its options, RPC protocol types, JsonAgentSessionEvent, Theme,
CustomEditor, renderer/UI components, ExtensionMode, AgentSessionRuntime and
plugin lifecycle remain. Direct external users of the excluded modes lose
those exports and must supply their own host. This change does not claim zero
impact for arbitrary external SDK consumers or justify deleting all helpers.

| Check | Result and scope |
| --- | --- |
| Retained behavior | Five files pass 90 tests with 142 Bun assertions and no failures. Both Pi package names load real TypeScript plugins, apply theme styling, register and render DynamicBorder, and create a CustomEditor subclass through the host editor factory. Text input and Escape behavior pass. Existing RPC client and ExtensionUIHost tests cover explicit CLI input, JSONL, mode/hasUI, reload, dialog cancellation and unsupported terminal factories. |
| Worker | The worker bundle smoke passes 26 tests with 103 assertions and no failures. It uses temporary data and deterministic local fixtures. |
| Declarations | Coding build:types passes. A separate directory resolves the built `./native` declarations through a package symlink. TypeScript accepts retained factories, editor inheritance, theme methods, RPC types and context mode, and checks that all five removed exports are absent. This is a declaration consumer, not a fresh frozen install. |
| Generation | The two pinned upstream entry points reproduce their output and inventory records with scoped --check. Missing and duplicate export boundaries are rejected. No full generation or source audit runs. |
| Source records | The inventory has 221 TypeScript records, including 217 under src/pi, and seven assets. Seven changed source/test overrides are synchronized and three deleted records are removed from both inventories. These are retained-file counts, not a recomputed minimal closure. |

The first component probe incorrectly treated KeybindingsManager as a runtime
root export; it is a type export. The final plugin uses the host editor factory.
The declaration probe first used the legacy default entry and assumed a public
ExtensionMode name. It now uses `./native` and the public context mode property;
a stale root.ts file-list entry was also removed before the successful check.
No production export was added to satisfy either probe. The native entry's
old complete-API comment is corrected to state the run-mode exclusion.

The CI command first hit an incorrectly set one-second background limit and
was stopped by the tool. No matching CI process remained. A rerun with a
sufficient limit passes validate:ci in 61 seconds. The independent review
relative to 5662422 found no confirmed correctness defect in the specified
code slice. It checked export order, remaining callers and the real component
fixture. The main thread ran the behavior and declaration checks above; the
review did not run them. The native entry comment was corrected separately by
the main thread. A review skill started an extra fork despite the single-agent
restriction. That fork ended, and its output was excluded from the conclusion.
The denied theme token check and unverified remaining helper boundaries stay
open under F1/F3. This slice does not repeat the complete repository test entry.

## Complete repository entry at 5662422

The isolated configuration ran the full repository entry at clean HEAD 5662422
and exited 0 in 598 seconds. Its main batch passed 6872 tests, skipped 11 and
failed none across 488 files. All 35 isolated files completed. This is one
successful complete entry for that source version; it does not erase the
previous watcher failure or apply automatically to the later run-mode deletion.
No provider, real account, real HOME or product UI was used.

## Launcher-only argument helpers after df2868f

On 2026-11-09, a focused caller and export check found that printHelp and
normalizeSessionName only served the removed launcher. Neither function has a
remaining caller or a public root export. Both functions and the three imports
used only by help output are removed. Args and parseArgs remain public, and
model resolution retains isValidThinkingLevel. The argument module has 263
lines instead of 480. This removes launcher scope; it is not an SDK replacement.

| Check | Result and scope |
| --- | --- |
| Regression | Four helper, scoped-source, model and extension files pass 71 tests with no failures and 96 Bun assertions. The new generator check rejects every missing or duplicate removed declaration or import while retaining the parser. |
| Retained behavior | Direct calls pass for all seven thinking levels, invalid-level warnings, RPC options, tool lists, extension flags, file arguments, the argument terminator and missing-value diagnostics. Model calls pass for valid and invalid suffixes, exact colon-containing IDs and a scoped max suffix. No provider is called. |
| Types and source | Coding declarations build. The fixed Pi 1.5.0 source reproduces the argument module and its inventory record with `--check --file=cli/args.ts`. The inventory and three changed-file override hashes are updated. |

The transform records exclude-upstream-cli-helpers and guards the removed
boundaries without binding the discarded help text to a body hash. The source
inventory remains 224 TypeScript files and seven assets. This slice does not
repeat full source generation, a Craft audit, the complete test entry or product
UI checks. The earlier complete-entry failure and denied theme check remain
open, as do the remaining programmatic-mode boundaries under F1/F3.

## Explicit RpcClient entry after bbdf61e

On 2026-11-09, the Coding source review's launcher finding was reproduced with
a local fixture. With no cliPath, the previous client started `dist/cli.js` from
the caller's working directory. Its comment claimed to search for an entry, but
the implementation used only that fixed relative path.

RpcClient now requires a caller-provided cliPath at start and rejects a missing
entry before spawning a process. The option remains optional at construction;
calling start without it has a clear diagnostic. Explicit Node CLI entries
retain cwd, environment, provider, model, extra arguments and JSONL behavior.
This change does not add an upstream launcher or change a durable task version.

| Check | Result and scope |
| --- | --- |
| Reproduction | The four-test process fixture failed on the missing-entry check before the fix; its other three tests passed. |
| Bun behavior | All four tests pass after the fix. They cover a cwd launcher that must never start, explicit requests and option forwarding, an RPC error response, shutdown, startup failure and failure during an outstanding request. |
| Node consumer | The same test body, with only the test framework import changed, passes all four tests under Node 24. The consumer copies only RpcClient and its JSONL helper, matches both source hashes and uses temporary HOME/config/cache without account credentials or provider calls. |
| Source and types | Fixed Pi 1.5.0 source reproduces the single RpcClient file and its inventory record with `--check --file=modes/rpc/rpc-client.ts`. Six scoped-check argument guards pass. Coding declarations build, including the corrected option comment. The three changed source/test override hashes match. |

The runtime inventory and generator record `require-explicit-rpc-cli-entry`.
Both independent source reviews are complete. The Coding review did not confirm
a further complete replacement through pristine Pi 1.5.0 SDK APIs. Its checks
do not prove all remaining sources necessary. Existing tool factories, resource
policy, model configuration, synchronous session trees, compaction hooks and
renderer lifecycle have specific contracts that need to be kept distinct from
a complete CLI or programmatic-mode requirement. Shared helpers supplied by
local patches remain separate from published SDK reuse.

The complete-entry failure recorded below is unchanged. This slice does not
repeat the full test entry, product UI or full source generation. Programmatic
mode scope, CLI helper scope, the denied theme token check and F1/F3 remain open.

## Published core default conversion after 3525c98

On 2026-11-09, the Native Agent stopped copying `defaultConvertToLlm` and
now uses the published core default. The generator no longer extracts that
function. The core patch also removes the converter-default field and its
constructor branch. The Native facade has 105 lines; its two mutable model
and usage defaults remain separate. Existing reflection tests do not establish
that Proxy receivers, constructor arity or getter order are product requirements.

| Check | Result and scope |
| --- | --- |
| Behavior | Eight explicit Agent, tool, recovery and CodingHost files pass 70 tests with 587 Bun assertions and no failures. Conversion checks cover role filtering, a new result array, original message identity and an explicit asynchronous converter. |
| CI and declarations | A new `validate:ci` run passes in 82 seconds. Coding `build:types` also passes and produces no tracked declaration changes. |
| Source and patch | The fixed upstream Agent revision and source hash match. The helper reproduces the 105-line facade. All four core files apply cleanly from restored pristine artifacts and match the installed output. Runtime and Craft override hashes are updated. |
| Independent consumer | A fresh frozen install with scripts disabled passes under network denial. All four core files and 22 copied consumer files match. Bun and Node 24 each pass the same seven facade tests without provider calls. The consumer lock is unchanged. Seeds come from local installed packages with core and durable patches reversed and checked; registry tarball integrity is not rechecked. |

The first consumer attempts exposed incomplete seeds in an older narrow cache:
missing durable patch files, chord and pi-schema modules. A cache-completion
helper also failed to stop directory lookup for Bun built-ins; it was stopped
and corrected before the successful install. These failures did not change the
workspace dependency manifest or lockfile.

The repository entry passed its main batch: 6867 tests, 11 skips and no failures
across 487 files. It then stopped at the native fork isolated fixture. The
validation harness had fixed `PI_CODING_AGENT_DIR` to a different temporary
HOME from the one created by that fixture. Removing the override lets its
unchanged SQLite/JSONL fork, ownership and restart test pass all 381 assertions.

The remaining isolated suites ran in entry order. Eighteen files passed before
the PowerShell fixture failed. Temporary configuration lacked the repository
`config-defaults.json`, so the first command returned a configuration error and
never activated the tool. Supplying that file in the task-owned config lets the
unchanged approval fixture and the final four files pass. Together, the original
entry, fork rerun and two continuation runs cover all 35 isolated files. This is
split-run evidence; the complete entry did not return zero in a single run.
Runtime code and test expectations were not changed for either environment fix.

A final entry run with both environment corrections returned 1 after 443 seconds:
6866 tests passed, 11 were skipped and one failed across the same 487 files.
The Skill URL icon fixture did not create its expected file before its deadline.
Its unchanged four-test file then passed in isolation with the same temporary
configuration. The failure's cause is not established. This entry did not reach
the isolated batch; the 35-file split-run evidence above remains separate from
a successful complete entry.

Review also narrowed earlier retention claims. Summary progress isolation has a
regression, but no product caller that starts multiple summaries concurrently
was confirmed. Historical runtime support concerns old snapshot recognition,
migration or safe settlement; a root export alone does not justify retaining
its complete implementation. Both independent source reviews are complete.
The Coding review found no further confirmed complete replacement through
pristine Pi 1.5.0 SDK APIs. It did find that RpcClient defaults to the removed
`dist/cli.js` launcher and incorrectly documents an entry-point search. That
concrete entry contract needs correction. Programmatic mode scope, remaining
source boundaries and the denied `theme-tokens.ts` check stay open. No complete
runtime generation, Craft audit, product UI, real account, paid provider or new
platform check runs in this slice.

## Repository checks after 4306eeb

On 2026-11-09, full repository validation used temporary child-process HOME,
config and cache directories. Only PATH, temporary-directory, locale, timezone
and terminal settings were inherited. No account or model credentials were
passed to the children. The parent process HOME was not changed.

`bun run validate:ci` passed in 103 seconds. It includes all workspace typechecks,
61 shared tests, 20 document-tool tests, and i18n parity, usage and sort checks.

The first `scripts/run-tests.ts` attempt reported 6852 passes, 11 skips,
4 failures and 1 import error across 487 files. The import error came from a
stale static dependency check in `shared-sessions-runner.test.ts`: it included the extension loader,
which now shares the Native Coding SDK module map. The check remains in place
for session storage and extension runners; the loader is checked by its behavior
and plugin-consumer tests. No runtime dependency restriction was removed from
those storage or runner entries.

The other three failures came from the validation harness setting `PI_OFFLINE=1`
for all tests. `checkForAvailableUpdates()` returns no updates in that mode,
so the local npm/git fixtures could not exercise explicit update and shutdown.
Removing that global setting fixed these failures. The package implementation
and its tests were not changed. Temporary configuration and credential isolation
remain in place.

The focused rerun passed 39 tests with 253 assertions and 0 failures:

```sh
bun --no-env-file --config=/dev/null test \
  packages/pi-durable-coding/test/shared-sessions-runner.test.ts \
  packages/pi-durable-coding/test/host-package-commands.test.ts \
  packages/pi-durable-coding/test/extensions.test.ts \
  packages/pi-durable-coding/test/plugin-transpiler.test.ts
```

The complete repository rerun passed 6864 tests with 11 skips and one failure
across 487 files. The failure was in the bundle concurrency fixture: its two
JSONL results arrived before the creation diagnostic on stderr. The fixture
stopped the process before it collected that diagnostic. It now waits for both
results and the diagnostic before asserting one kernel creation. Runtime code
was not changed. All 26 bundle tests then passed with 103 assertions and no
failures. The source overrides include both corrected test hashes.

The source checks below establish provenance and reproduction; they do not
close the remaining necessity review.

- Scoped generation reproduced 219 allowed Coding TypeScript outputs from fixed
  Pi `f9a26365568127461c47a07a37dcb42c140a3ac5`. Their source and output hashes
  matched. The result remains `complete: false`.
- The other four generated TypeScript outputs matched their recorded source and
  output hashes. Their generation was not rerun. All seven Pi assets matched
  both the pinned source and local inventory without changes.
- Complete `vendor-upstream.ts --check` verified 12 source outputs and 28 shared
  forwards from the same pinned revision.
- `patch-generation-response.ts --check` replayed the complete durable patch
  against pristine 1.5.0, verified all 30 output sections and checked the four
  generated generation/response and root-export artifacts.

The denied `theme-tokens.ts` body was not read or generated. Full runtime
regeneration remains blocked by that restriction. No Craft audit, real account,
paid model, product UI, Windows or signed-release check was run in this batch.

## Shared extension lifecycle after 38306f7

On 2026-11-09, the two extension loaders started using one local implementation
of `createExtensionRuntime`, `createExtensionAPI`, `createExtension`,
`initializeExtension` and `loadExtensionFromFactory`. The legacy generator removes
those five declarations and imports or forwards the Native entry points. Its
JavaScript output falls from 631 to 235 lines. Native only exports the initializer
from its private loader module; the public Coding root does not add that export.

The earlier claim that private initialization state required the whole legacy
loader was too broad. These functions hold runtime and factory state per call.
Each loader still owns its module table, factory cache, cwd, generation and
path discovery policy. Native plugins retain the Coding SDK; legacy plugins
retain compat, reject old Agent execution and reject private subpath fallback.
This reduces a local source duplicate. It does not establish a published,
independent Coding loader API. No dependency, SDK patch, task version or
checkpoint changes in this slice. The inventories remain 224 TypeScript sources
and 7 assets, plus 12 selected outputs and 28 shared forwards.

The affected behavior checks used two commands:

```sh
bun --no-env-file --config=/dev/null test \
  packages/pi-durable-coding/test/extensions.test.ts \
  packages/pi-durable-coding/test/plugin-transpiler.test.ts

bun --no-env-file --config=/dev/null test \
  packages/pi-durable-coding/test/host-resources.test.ts \
  packages/pi-durable-coding/test/host-package-commands.test.ts \
  packages/pi-durable-coding/test/scoped-port-check.test.ts \
  packages/pi-durable-coding/test/native-session-recovery.test.ts \
  packages/pi-agent-server/src/coding-host.e2e.test.ts \
  packages/pi-agent-server/src/coding-host-catalog.e2e.test.ts \
  packages/pi-agent-server/src/coding-host-prompt.e2e.test.ts
```

The first command passed 19 tests with 90 assertions. The second passed 60 tests
with 516 assertions. Both had 0 failures. New checks cover separate module maps
and cached factories, clearing one cache without clearing the other, committed
inline registrations, command source identity, listener cleanup, stale APIs and
failed-factory rollback through both entries. Existing consumers cover both Pi
package names, Bun metadata, stack handling, resources, package commands,
permissions, tools, host prompts and real process recovery. Data and providers
are temporary and deterministic.

Coding typecheck, declaration build, worker typecheck and worker build passed.
The pinned Native loader scoped check passed with `sourceFiles: 1` and
`complete: false`. A scoped harness ran the actual `port` declaration from
`vendor-upstream.ts` against the same pinned upstream loader, without running
the complete generator. It checked the old recorded output hash before writing.
Two invalid source fixtures, a missing inline factory declaration and a duplicate
initializer declaration, were rejected by the shared-function count guard. Both
source manifests record the new transforms and output hashes.

An independent read-only review against `38306f7` covered the seven runtime,
generator, inventory and test files plus their required direct dependencies and
exports. It found no correctness issue with a concrete trigger. The five shared
functions matched the removed implementations after type and comment removal.
The review confirmed separate module maps and caches, no new initialization
cycle, and no new public Coding root export. In-memory reproduction matched
both loader outputs and their manifest records. Twelve boundary probes rejected
a missing or duplicate declaration for each legacy shared function and a renamed
or duplicate Native initializer. Those probes cover these specific declaration
boundaries; they do not establish rejection of every upstream signature, body or
dependency change. The reviewer did not rerun behavior tests, types, builds or
host checks, and did not review the later documentation and source overrides.

No full source generation, full repository suite, Node run, Windows check,
Craft audit, real account, paid model or product UI was run for this slice.
The denied `theme-tokens.ts` body was not read. F1 to F3, remaining Coding
sources, execution adapters and SDK patches remain open.

## Coding SDK scope after 461e7c9

On 2026-11-09, the Coding root stopped exporting the upstream CLI launcher
`main` and its `MainOptions` type. MkAgent assembles sessions through
`CodingHost/createAgentSession`; no repository product caller of those two
exports was found. The package has no CLI bin. Programmatic InteractiveMode,
print/rpc, tool and session factories, plugin UI components and the public
MCP/codemode/tool-search factories remain available. This change does not
establish that every external plugin is independent of the removed launcher.

The generator removes the pinned launcher export before it traverses imports.
Removing the export only from the final output would still copy the launcher's
private dependency set. Its exact anchor must occur once or generation fails.
The local import graph identified 24 files reachable only through that launcher,
with 6757 lines. They include CLI authentication and configuration, package
commands, self-update, old Pi config migrations and the CLI extension collection.
Llama management entered through that collection and had no separate root export.
Shared args, auth-command and runtime helpers remain. MkAgent migration and
durable checkpoint code did not change.

Before deletion, each file matched its recorded output hash. The files and their
source records were removed. The runtime inventory now contains 224 TypeScript
sources, including 220 under `src/pi`, and 7 assets. The previous counts of 248
and 244 apply to earlier versions. This is source scope reduction; it does not
mean that an official SDK now replaces each of those 24 files. Remaining Coding
sources and patches still need their own necessity checks.

The graph check treated `theme-tokens.ts` as a retained leaf without reading its
body. It was a local graph difference check, not a full upstream generation or
source audit. A pinned-source scoped check of `index.ts` passed with
`sourceFiles: 1` and `complete: false`. Coding typecheck, Coding declaration
build, worker typecheck and worker build also passed.

The behavior run used:

```sh
bun --no-env-file --config=/dev/null test \
  packages/pi-durable-coding/test/plugin-transpiler.test.ts \
  packages/pi-durable-coding/test/extensions.test.ts \
  packages/pi-durable-coding/test/host-resources.test.ts \
  packages/pi-durable-coding/test/host-package-commands.test.ts \
  packages/pi-durable-coding/test/scoped-port-check.test.ts \
  packages/pi-durable-coding/test/native-session-recovery.test.ts \
  packages/pi-agent-server/src/coding-host.e2e.test.ts \
  packages/pi-agent-server/src/coding-host-catalog.e2e.test.ts \
  packages/pi-agent-server/src/coding-host-prompt.e2e.test.ts
```

Result: 75 tests passed, 0 failed and 569 assertions across 9 files. The new
Native loader consumers import both `@earendil-works/pi-coding-agent` and
`@mariozechner/pi-coding-agent`. Each creates an in-memory session, registers a
read tool from the SDK factory and checks retained mode and UI exports. Existing
checks cover loader metadata and stack handling, resources, package commands,
real process recovery, tools, permissions and host prompts. Tests use temporary
data and local deterministic providers.

An independent read-only review against `461e7c9` covered the 27 runtime,
generator and inventory changes before the later test and documentation updates.
It found no correctness defect with a concrete caller. It checked relative
literal references in 339 retained source files, excluding `theme-tokens.ts`,
and found no references to the deleted files. Product session assembly, trust,
durable recovery and session format migration still use retained implementations.
The reviewer did not independently run behavior tests or check dynamically built
paths and external plugins. The launcher removal is an implementation decision
under F1/F3, not a separate user requirement to remove those export names.

No full repository suite, Node run, Windows check, full source regeneration,
Craft audit, real account, paid model or product UI was run for this change.
Historical counts and product results below retain their original scope.

## Plain AgentTool SDK delegation after 1eb4435

On 2026-11-09, `DurableLoopBinding` started sending plain AgentTool effects
from the public Agent/runToolCall entries through the existing public ToolTask
bridge. Tools already using that bridge keep their execution path. Native still
owns preparation, permission hooks, complete results, events and journal writes.
Direct low-level CodingToolTask fixtures can supply their own executor; this
change does not make that internal entry an automatic SDK bridge.

Independent review found three defects in the first implementation. All three
have targeted regression coverage after correction:

- Cancellation during SDK admission could still start an effect. The shared
  bridge now checks the signal immediately before the registered effect.
- SDK validation ran again after Native permission hooks. The internal accepted
  effect bridge now omits that second schema check. Public Native preparation
  and validation still precede permission hooks, whose argument changes are final.
- Argument mutations could be lost after the SDK result commit and before the
  Native outcome commit. Final execution arguments now share the SDK result's
  atomic receipt. Normal delivery and recovery use that snapshot. Old receipts
  without the optional field fall back to accepted Native arguments; a host
  `finalArguments` callback retains priority.

The initial schema guard tests used numeric input for a string property.
Published pi-ai validation coerces that input, so both tests incorrectly expected
rejection. They now omit the required property and assert a validation error,
zero additional permission calls and zero additional effects. Legal permission
changes that add an undeclared property still reach the effect.

Product checks then found two failures: AgentSession conversions dropped the
bridge marker, so tool-search and a builtin write tried to enter ToolTask twice.
Both AgentTool/ToolDefinition conversions now preserve the marker. The source
transformation and provenance record reproduce those three added lines. Product
expectations were preserved. Agent recovery tests now expect the SDK's
`<harness>` uncertain-effect diagnostic while retaining exact effect-count and
safe/unsafe replay assertions.

Final checks for this slice:

- One combined run across 17 Coding and worker test files: 172 pass, 0 fail,
  1,305 assertions. It covers preflight, cancellation, complete results and
  updates, Native and SDK replay policies, codemode ownership and usage,
  journal transactions, session and summary recovery, product approvals,
  deferred tool activation and product usage.
- Three added real SIGKILL cases stop after the SDK result commit while the
  Native owner still has an execute checkpoint. New receipts retain final
  arguments with the tool present or removed. An old receipt without the field
  falls back to accepted arguments. Each case records one effect only and
  preserves the full result. These new cases ran under Bun.
- Coding typecheck, Coding declaration generation, worker typecheck and worker
  build pass. A scoped pinned-source check reproduces
  `core/tools/tool-definition-wrapper.ts` and its provenance record. No SDK
  patch, runtime dependency, task version or document version changed.
- Thirteen scoped Craft source hashes and reasons match. The five documents
  pass punctuation checks and 86 local link/anchor checks. `git diff --check`
  passes. No full Craft audit or source regeneration ran.

The summary review found no copied stream-consumption algorithm: the producer
already uses `StreamFn(...).result()`. A new regression runs two summaries while
preserving a main conversation generation slot with attempt 7. The current
GenerationResponseTask and its partial writer use that same conversation slot,
so they cannot directly replace this isolated summary path. Session admission
also retains atomic Native child/state/journal commits and uncertain callback
boundaries. The [architecture record](coding-architecture.md#summary-与-session-的-sdk-边界)
lists candidate APIs, gaps, removal conditions and upgrade checks. Summary and
session runtime code did not change.

The reviewer reported an accidental nested review-skill invocation despite the
no-subagent instruction, then verified the three findings in their own thread.
No second independent review ran after correction. The full repository suite,
new Node crash cases, Windows, signed packages and real services were not checked.
F1 to F3, the complete Coding source scope and remaining patches stay open.

## Public edit argument preparation after 456241a

On 2026-11-09, the Native edit factories started using the published
`@earendil-works/pi-durable/tools` callback from
`createEditTool().prepareArguments`. The local conversion function, single-edit
predicate and two private input types were removed. No dependency or SDK patch
changed. Native file operations, validation, mutation queue, cancellation,
renderers and public TypeBox types remain.

The SDK repairs JSON arrays, JSON objects, single objects and legacy top-level
fields on a copy. The original call arguments remain unchanged. Core preparation
uses the returned value for validation; it does not require mutation of the
recorded input. The previous full edit execution adapter assessment below is a
historical decision about file execution, not a reason to retain this conversion.

Checks completed for this slice:

- `bun --no-env-file test packages/pi-durable-coding/test/native-edit-arguments.test.ts packages/pi-durable-coding/test/native-edit-diff.test.ts`:
  324 pass, 0 fail, 649 assertions. The 12 new tests cover both Native factories,
  seven valid input forms, unchanged recorded inputs, actual BOM/CRLF file edits,
  result details and three invalid inputs rejected before file access.
- Coding `typecheck` and `build:types`: passed.
- `vendor-coding-runtime.ts <pinned-checkout> --check --file=core/tools/edit.ts`:
  one source output and its provenance record match. This is a scoped check,
  not a full source regeneration. The source SHA-256 remains
  `d05eb64ada7755eb5269befbee09fafd2bb26e266476c020ad9d721f9f0df8d7`;
  the port SHA-256 is
  `e454600ff129191453427a3b438e121a576a8c4c8e52d3fb171d0d343558bcb2`.
- Four scoped Craft source records match their file hashes. The five updated
  documents pass punctuation checks and 80 local link/anchor checks.
  `git diff --check` passes. No full Craft audit or source regeneration was run.

The same review compared published `GenerationTask.tools`, `finish`,
`startToolRound` and `finishToolRound` with Native admission, delivery and final
settlement. Both implementations require every call to terminate and select the
last handoff. The remaining gap is the SDK phase's combined transcript writes,
ToolTask creation, inbox handling and next-generation handover. The
[architecture record](coding-architecture.md#工具轮次与收尾的-sdk-边界) lists the
retained adapter, product wrapper scope, removal conditions and upgrade checks.
No round or final-settlement code changed, and no new round patch was added.

This slice does not repeat the earlier request, cancellation or crash matrix.
It does not establish full plugin, independent-consumer tool execution, Windows,
full-repository or product-package acceptance. No separate reviewer was used for
this callback replacement. Session/summary and the complete Coding source scope
remain open.

## Prepared generation response after 62ed325

The request adapter now calls a new repository SDK task,
`GenerationResponseTask` v1, on the real `pi.coding.run` owner. This is a local
patch API. Published `GenerationTask.request` continues into classification,
assistant writes and tool creation; it has no independent response return.
The new task reuses the existing SDK `streamResponse` and partial writer.
It does not classify, append a transcript, charge usage or create tools.
Original GenerationTask v4 and all five Native task kinds stay at their current
versions. This does not establish every historical migration combination.

Core still converts context, binds credentials and delivers Native events.
The SDK drains the final partial commit before `message_end`. Native tool
admission uses the message after plugin edits. SDK receipt, the unique Native
assistant entry and the next checkpoint commit in one transaction. Request
credentials, headers and callbacks remain in memory. Interrupted request or
event delivery is not repeated; SDK settlement clears the generation slot.
External cancellation and scheduler abort join stream cleanup. Scheduler abort
calls the SDK abort phase without a second assistant write.

Checks for this slice:

- Five files pass 55 tests: `generation-response-sdk`, `agent-recovery`,
  `native-journal-transactions`, `native-session-task` and worker `coding-host.e2e`.
  The new 13-case suite covers plugin call removal/replacement/addition, length
  errors without effects, atomic commit and rejection, ephemeral options,
  partial drain, both cancellation paths and three real SIGKILL boundaries.
- Node 24.22.1 passes the same three source-fixture SIGKILL boundaries: request,
  `message_end` and accepted response before finish. Requests are not repeated;
  only the accepted boundary preserves an assistant. Pending work and generation
  progress are cleared.
- Coding typecheck, worker declaration generation/typecheck and worker build
  pass. The rebuilt bundle passes three offline cases: code mode/MCP startup,
  dynamic tool publication and the adjacent Photon resource.
- After the patch fix below, the request and image-orientation suites pass
  27 tests, including the complete-content patch digest check.
- The new generator checks pinned source and TypeScript declarations, preserves
  unrelated sections, applies the entire patch to a pristine copy and compares
  all 30 outputs. Its `--check` mode passes. The manifest now records all files.
- A new consumer installs 133 packages from the existing cache with network
  denied and lifecycle scripts disabled. Its first unconstrained offline
  resolution failed because cache metadata was missing. Repository resolutions
  were then used to prepare its lock; the first frozen attempt correctly
  rejected lock normalization. After normalization, a clean frozen install
  passes, all 30 patched files match the manifest and both task root exports
  resolve. This uses the existing cache, not a new empty cache.

- Eight scoped source override hashes and reasons match. The five changed
  documents pass 74 local link/anchor checks, language punctuation gates and
  `git diff --check`. No full Craft source comparison was run.

Independent review found two invalid EOF markers in preserved `live.d.ts` and
`types.d.ts` hunks. The old string/hash-only check missed them. Both markers are
removed; the generator now runs full `git apply --check`, applies the patch and
compares every output before writing. Bun patch reconstruction also removed the
required complete-content digest line; the generator restores and recalculates
it. The earlier temporary upstream checkout had lost source files, so the final
check uses a new sparse checkout of the pinned revision. There has been no
second independent review after these fixes.

The full repository suite, real services, Windows, signed packages and the full
historical checkpoint migration matrix have not been checked for this slice.
Tool rounds, finish, session/summary and the complete Coding source boundary
remain open under F1 to F3. The local extension is removed only when an upstream
prepared-response API can preserve the required event and transaction behavior.

## Public ToolTask host execution after 552b938

The first runtime change delegates host execution to the published Pi 1.5.0
`ToolTask.definition.phases.call`, `phases.execute` and `definition.abort`.
It adds no dependency patch. The existing `pi.coding.tool` v1 remains the
scheduler task and journal owner. A task document stores the SDK version,
checkpoint and complete Native result. Official nested calls remain real
`pi.tool` tasks. The local `host-tool-nested.ts` copy is deleted.

The SDK handles effect execution, bounded host output, pacing, nested
admission, replay checks and nested-tool cleanup. The Native layer still owns
preflight and permission hooks, complete text and image results, usage after
`afterToolCall`, plugin events and journal commits. A private JSON receipt
preserves the complete Native result without changing the official nested
result schema. Calls with another tool name or other arguments cannot reuse
that receipt. Old v1 checkpoints without the new document keep their existing
replay rules. An SDK result committed before the Native outcome can be restored
even if the tool has since been removed.

Two cancellation paths exposed separate requirements. An external signal must
stop the effect while SDK settlement uses the live task context. Otherwise the
parent can wait on a child whose cleanup has not been started. A scheduler abort
also needs the public ToolTask abort handler after the scheduler joins execute;
without it, finished child tasks leave progress slots behind. Both paths now
wait for owned cleanup and remove the parent and descendant slots.

Independent review confirmed three new defects: SDK safe intent could bypass
Native never, concurrent calls could share arguments or repeat an unsafe effect,
and a captured memo API could still write after SDK settlement. It also confirmed
an existing failure-cleanup gap: a plain owned child could keep the Native owner
in completing because the adapter discarded the SDK failed outcome. The initial
84-test batch did not cover these cases.

The fixes constrain replay by both recorded and current Native/SDK policies,
reject overlapping host calls and check identity again inside the transaction.
A local API lifetime ends after accepted operations have joined, including for
captured conversation handles. External cancellation also rejects operations
that try to use a still-live task context. SDK failure is stored with the complete result.
After Native hooks and events, the real owner ends failed so the official
scheduler cancels and joins its owned tasks and owned conversations. Callers
accept the marked delivered tool result; event-delivery failures retain their
existing error path. No separate ownership cleanup algorithm was added.

The expanded 22-test suite includes twelve real SIGKILL/restart cases with
temporary JSONL storage. Four check recorded/current SDK policies. Four check
independent Native restrictions, including a legacy SDK-safe/Native-never
receipt. Two restore complete results with the tool present or removed. Two
restore SDK failure with both a direct owned child and a child in an owned
conversation, again with the tool present or removed. They check effect counts,
complete large text, images, structured results and completed cleanup. Other
cases check phase delegation, conflicting/concurrent calls, API closure, nested
cleanup and both cancellation paths.

The fixture first failed because TaskId was written as a filesystem string and
because reopened tasks were expected to be running rather than pending. It now
stores the ID as JSON and checks the observed recovery state. During the review
fixes, transaction identity initially compared a Draft with plain JSON; copying
the Draft inside the transaction corrected that rejection. The owned-conversation
fixture initially passed a record instead of its ID. A regression also required
Native policy lookup to remain inside the invocation scope. These were corrected
before the final batch below.

Checks after the review fixes:

- Seven files pass 96 tests: `host-tool-sdk`, `host-tools`,
  `durable-coding-tool-task`, `native-journal-transactions`,
  `native-codemode-usage`, `agent-recovery` and worker `coding-host.e2e`.
- Coding typecheck, worker typecheck with Coding declaration generation, and
  worker build pass. No remote provider or real account is used.
- The offline worker bundle passes three cases: code mode/MCP startup, dynamic
  tool publication and the adjacent Photon resource.
- Node passes all twelve SIGKILL/restart scenarios. The effect counts, policy
  restrictions, complete Native results and failed-owner cleanup match Bun.
  This is a source-fixture check, not a new frozen-install test.
- Nine changed source/test hashes and their reasons match the source override
  records. The deleted adapter has no stale entry or runtime import. This scoped
  check does not run the full Craft comparison.
- Local links and Markdown anchors in the five updated documents, their
  language-specific punctuation gates, and `git diff --check` pass.

The independent review is complete; the fixes above have local regression
coverage but have not had another independent review. The full repository
checks, standalone frozen-install consumer rerun, production journal crash
matrix, Windows and signed product packages have not been rerun for this
change. GenerationTask integration, session/summary assessment and the full
Coding source boundary remain open under F1 to F3.

## Pi Coding layer and execution-base clarification after 301598c

The 2026-11-08 user clarification explains why the work exists: replacing Pi
coding agent directly with durable left Coding and Pi plugin gaps. The target
keeps Pi coding agent's Coding layer for MkAgent and attempts to replace its
execution base with durable. The earlier source-copy approach also requires
correction because it increases maintenance on both upstream packages.

Git history identifies `b77c4a2645d361deb5f954cf8f2e57d46d0b2b91` as the parent
of the first runtime replacement in `e4b75c2`. That parent's worker manifest
pins `pi-coding-agent` 1.1.0, and its entry imports `createAgentSession` and the
Coding session interfaces. This establishes an original integration reference;
no product behavior was rerun against it. The current SDK comparison remains
Pi 1.5.0. Confirmed behavior through `cb0311f` and later fixes, accepted work
and existing stored data must also remain. No rollback is requested.

The revised requirements distinguish the Pi Coding layer from its execution
base, require SDK reuse before source copying, and make remaining source,
generators and patches part of the upgrade assessment. Each exception needs a
confirmed gap, removal condition and checks for the next Coding/durable update.
The existing full-package production dependency constraint does not justify
copying the Coding SDK. No SDK injection or replacement design is declared
feasible by this documentation change. F1 to F3 remain open.

Local checks for this batch cover 24 Markdown files:

- All 281 local links resolve, including the referenced heading anchor.
- Changed text in all files and the complete seven core documents pass the
  language-specific punctuation gate. Eleven other documents retain findings
  outside the changed text; those passages are not rewritten in this batch.
- All seven historical bodies below their current-direction notices are
  unchanged from `301598c`. Existing validation receipts are also unchanged.
- The stale current-direction phrases checked in the affected entry points
  are absent. `git diff --check` passes. No runtime, dependency, test or stored
  data changes are part of this batch.

Independent semantic review covered all 24 diffs and the relevant surrounding
text, including the seven core documents, language pairs and historical
notices. It found no actionable semantic issue and separately checked links,
the referenced anchor, preserved historical bodies and `git diff --check`.
The reviewer accidentally invoked a skill that spawned extra execution,
contrary to the review brief. That result was excluded; the reported conclusion
comes from the reviewer's subsequent direct reading.

This completes the documentation batch. No product, full-repository, browser
or CI run was performed for these edits. SDK integration feasibility and
runtime correction remain open under F1 to F3. Historical results retain
their original scope.

## Kernel migration scope confirmation after 56d0f46

The 2026-11-08 scope review covers the 34 document diffs from `cb0311f` to
`56d0f46`: seven core documents and an independent review of the other 27.
No runtime, dependency or test changed in those two documentation commits.
The existing MkAgent layers, shared renderer, authenticated RPC, Pi backend,
subprocess boundary, host responsibilities and product persistence remain.
The server-core guide describes existing responsibilities; it does not move
them into that package.

Some wording was too broad: generic architecture changes, removal of the
absolute host-change ban, and a historical notice that also set aside technical
boundaries. This follow-up limits changes to kernel integration and required
Coding/plugin compatibility. Existing architecture and safety constraints stay
in effect; host changes are limited to necessary contract adapters. Durable
storage and execution responsibilities refer to the kernel, not all MkAgent
product state. The official Pi SDK priority, capability requirements and stored
data guarantees remain in force. Historical bodies and validation receipts
retain their original scope.

This clarification changes 15 Markdown files. All 116 local links resolve,
including referenced anchors. Changed text and all seven core documents pass
the punctuation gate; `git diff --check` passes. Static comparison confirms
that the original topology diagrams and backend sections are unchanged from
`cb0311f`. Six historical bodies are unchanged from `56d0f46`. Existing
punctuation findings outside the changed text remain in four documents.
No product, model, CI or browser check was rerun for these scope statements.

## Documentation gap follow-up after 1314a2b

This follow-up on 2026-11-08 starts at `1314a2b`. It extends the first correction
to product and development entry points, the server-core guide, Craft sync
guides and migration archive notices. It also resolves remaining baseline and
SDK-source ambiguities in the core documents. Historical measurements, release
records and product test results retain their original scope.

| Gap found | Correction |
| --- | --- |
| Root and development entry points lack the current kernel direction | Link the capability specification and implementation plan; describe the Coding module and official Pi SDK priority |
| Migration archives still present old MCP/image removals and full UI source rules as current guidance | Mark the complete documents as historical; retain the old bodies and direct current work to the active specifications |
| Craft sync exclusions can include current kernel MCP/OAuth and image capabilities | Limit the exclusions to the specified Craft product features; preserve durable MCP, Coding MCP OAuth and codemode image generation |
| The Pi 1.1.0 sync statement can be read as a current repository-wide requirement | Date that release statement; distinguish root/shared/server-core pi-ai 1.1.0 from the Coding/worker Pi 1.5.0 dependencies |
| server-core describes sessions, handlers and domain logic as external responsibilities | Describe their existing server-core implementation and the separate Pi worker execution boundary |
| The first durable integration commit can be treated as the full product preservation baseline | Keep `85325251a10d`/`0959d3563892` as the historical inventory comparison; preserve `cb0311f` and subsequent confirmed product behavior |
| Codemode options, edit-diff helpers and core operation imports can appear to be unmodified published APIs | Label the options and exports as repository patch additions |
| Current task and replay versions are not explicit | Record published generation v2 versus patched v4, tool v3, five local Coding task kinds at v1, and codemode replay-module 2 versus 3; require stored-state compatibility |
| The execution summary omits the separate summary task | Include `pi.coding.summary` alongside the four main task kinds |
| First-batch F0 counts can appear to cover the follow-up | Keep separate receipts and update the current acceptance and plan status |

The source comparison uses the pinned, unmodified Pi 1.5.0 checkout and the
registered repository patch. `generation.ts` defines version 2, `tool.ts`
defines version 3, and `codemode.ts` defines module version 2. The patch raises
generation to 4 and the codemode module to 3. A task version, replay-module
version and document schema are separate identifiers. No runtime, dependency,
test or stored data is changed by this documentation follow-up.

The follow-up changes 20 documentation files: 19 Markdown files and the archived
HTML project analysis. Checks against `1314a2b` report:

- All 209 local Markdown links and 12 HTML local links resolve. Referenced
  Markdown heading and HTML ID anchors are included.
- Added and rewritten text in all 19 Markdown files and the HTML notice passes
  the language-specific punctuation gate. All seven core documents pass the
  whole-file gate. Eight other documents retain findings outside the changed
  text: both root READMEs, both development guides, the migration README and
  plan, the Markdown project analysis, and the Chinese upstream-sync guide.
- The HTML differs only in its first historical notice. Node 24.22.1 compiles
  its complete inline script without executing the page. The independent
  archive review also confirms unchanged Markdown bodies below the notices.
- Independent review of the seven core documents and targeted rechecks closed
  three findings: patch-added API wording, missing published/patched version
  boundaries, and the historical product baseline. A separate review covers
  all 14 entry, development, archive, sync and server-core documents, including
  all three English/Chinese pairs, with no remaining findings.
- Current manifests confirm root/shared/server-core pi-ai 1.1.0 and the
  Coding/worker Pi 1.5.0 dependencies. The registered core and durable patches
  still change four and 28 files. `git diff --check` passes; the changed-file
  inventory contains only these 20 documents.

F0 documentation correction and this gap follow-up are complete. The first
batch's 20-file and 191-link receipt below remains scoped to `1314a2b`; it is not
the follow-up result. No product, CI, browser visual or historical behavior
check was rerun for these edits. F1 to F3 and their affected runtime behavior
checks remain open.

## Migration direction correction on 2026-11-08

This first batch was committed as `1314a2b`. The user requires related documents
to be corrected before further runtime changes. The batch starts at `cb0311f`.
It corrects the following assumptions in requirements, architecture, plans and
acceptance records:

| Previous direction or ambiguity | Corrected requirement |
| --- | --- |
| Treat durable as a scheduler under a complete old coding runtime | Use its existing execution, tools, hooks, storage and recovery before adding local implementations |
| Prefer any independent public library | Prefer independent official Pi SDK packages after durable built-ins; third-party resource work does not satisfy that priority |
| Treat local patched exports as published Pi APIs | Record repository-added exports, options and hooks as SDK modifications with their own gap and upgrade cost |
| Preserve the full public source closure because the local root exports it | Derive the required surface from product behavior, public plugin contracts and data compatibility; assess CLI and plugin components separately |
| Use old private behavior and exact source tests as acceptance requirements | Verify the required contract first; keep permission, cancellation, error, result, lifecycle and recovery checks |
| Treat representative retention tests or one Harness as architecture completion | Check actual execution responsibilities and required compatibility boundaries; keep F1 to F3 open |
| Iterate until a theoretical minimum maintenance cost is reached | Complete confirmed corrections and necessary validation, state remaining evidence gaps and stop at the defined delivery conditions |

Source checks confirm that production already installs durable tools, images,
codemode and tool-search. `CodingHost` receives those tools through
`baseToolsOverride`. Its main path uses `AgentSession`, `DurableLoopBinding`
and local `pi.coding.*` tasks. The generator still starts from the full Pi coding
entry and includes upstream CLI and run modes. These are implementation facts,
not proof that the current source or task layout is necessary.

The root manifest registers core and durable patches. The core patch changes
four files; the durable patch changes 28. Core operation exports and Agent
injection, and durable `codingPrepare`/`codingStream`/`codingBoundary`, include
repository changes. Their presence in the installed SDK is not evidence that
Pi published those interfaces without modification.

An independent review compared the four task bridges with the installed SDK.
It reported 74 in-memory assertions, no real model or user storage access, and
no completed replacement implementation. The review found official scheduler,
ownership, transaction and wait API reuse, plus local request/tool state
machines. It also found transaction, full-result and uncertain-callback gaps
under the selected Native contracts. Those results guide the next comparison;
they do not establish permanent necessity of the complete local state machines.
The stored `pi.coding.{session,run,call,tool,summary}` kinds are v1 and require
explicit compatibility handling during a replacement. The independent bridge
review covered the first four. Source review also confirms that summary tasks
serve compaction, branch summaries and bug reports. They commit `requesting`
before the model request, refuse uncertain re-delivery, and retain completed
responses. Include those states and results in migration and recovery checks.

The documentation batch changes 20 files: 19 Markdown files and the HTML
architecture diagram. It changes no runtime source, dependency, checkpoint or
test. The final document checks report:

- All 191 local Markdown links resolve, including referenced Markdown anchors.
- Added and rewritten Markdown text passes the punctuation gate in each file's
  language. All seven core documents also pass the whole-file gate. An initial
  invocation selected English for seven Chinese documents and failed; the
  corrected language selection passes. That initial failure is not a pass.
- Six other documents retain existing punctuation findings outside the changed
  text: `kernel-durable-switch-spec.md`,
  `functional-stability-remediation-spec.md`, `../zh/architecture.md`, both
  comparison documents and `../migration/migration-mvp.md`.
- Node 24 compiles the complete HTML inline script without executing the page.
  All bytes outside the Pi node remain unchanged. The diagram edit changes only
  that node's summary, responsibilities and evidence references.
- Independent review covers all seven core document diffs. Its two findings,
  the missing summary task and an undated nine-resource count, were corrected
  and rechecked with no remaining findings. Review of the other 13 documents
  preserves historical bodies and measurements at their original versions.
- `git diff --check` passes, and the changed-file inventory contains only the
  20 documentation files. Manifest checks confirm core and durable patches of
  four and 28 files, 248 runtime TypeScript outputs and seven assets, plus
  12 auxiliary sources and 28 shared forwards. This batch does not regenerate
  those outputs.

F0 is complete for this batch. Earlier product, CI and source-reproduction
results remain historical evidence and are not reruns. No browser visual check
or product regression was run for these document edits. Runtime correction and
its affected behavior checks remain open.

## Published Highlight.js browser asset after f6c44c7

HTML export now reads the published third-party
[`@highlightjs/cdn-assets@11.9.0`](https://registry.npmjs.org/@highlightjs%2Fcdn-assets/11.9.0)
package instead of a copied browser library. This is not a Pi SDK package.
Its `highlight.min.js` is identical
to the pinned Native asset: 121,727 bytes, SHA-256
`837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846`.
The existing server package is Highlight.js 10.7.3, so it cannot supply the
11.9.0 browser file. The added asset package has no runtime dependencies;
other resolved dependency versions are unchanged. Its installed files occupy
about 4.2 MB; the build copies only the required browser file and license.

Markdown and highlighting share a 22-line external resource adapter. Source
mode resolves the public package assets. Bundle mode reads the shipped files
without package resolution. The Highlight.js resource includes a 1,520-byte
prefix with the package's complete BSD 3-Clause LICENSE. The parser itself is
unchanged. Loading the bundled resource does not add the notice again.
Native templates, the CJK extension and renderer configuration are unchanged.
The runtime manifest now has 248 TypeScript files and seven assets; the two
browser packages replace 166,367 bytes of copied libraries in total.

Bun passes 83 tests across the four HTML and generator test files. Node
24.22.1 passes 34 tests across the three portable HTML files. The complete
server build and both complete generation checks pass, including 12 auxiliary
sources and 28 shared forwards. Nine explicit type roots have zero
diagnostics. Local `validate:ci` passes workspace types, SDK declarations,
61 shared tests, 20 documentation-tool smoke tests and locale checks.
The Craft audit passes for 2231 files: 1455 common paths, 874
normalized-identical files, 581 modified Craft-derived files, 776 project-only
files and 858 reviewed deletions.

A relocated bundle uses the real SessionManager and both HTML export
functions. It has no local `node_modules`; a system sandbox denies network
access and reads from workspace dependency directories. Both exports produce
the same 287,305-byte HTML. Removing the added BSD notice produces the same
HTML as the pinned Native highlighting asset. The scripts extracted from the
final HTML execute CJK strong markup and TypeScript highlighting and retain
36 common languages. The first probe assumed that the complete library
would appear verbatim in the HTML and failed. Native template replacement
processes dollar replacement patterns in both versions. The corrected check
compares both exports under that same behavior and executes the final scripts;
it does not change the Native template. The failed probe is not a pass.

Independent review found no confirmed defect. The two browser test files
pass 20 tests under Bun and 20 under Node 24. A separate fixture passes 177
assertions across all 36 languages, 65 aliases, seven Native code renderer
samples and two escape fallbacks. Its first version failed to parse because
of a duplicate variable name; the corrected run executes all assertions.
Separate Bun and Node bundles cannot resolve either package, but load both
shipped resources, render Markdown and retain the highlighting version and
language list. Package fallback fails when no shipped resource is supplied.
Fixed fixtures for both actual export functions differ from the baseline only
by the BSD notice, including custom tool renderers and session data. These
fixtures do not repeat the complete Native session lifecycle. Review also
confirms exact generated exporter bytes, matching dependency versions and
unchanged manifest records outside the exporter and removed asset. The
reviewer did not repeat the main thread's complete build, generation or CI
checks and removed their temporary files with trash.

This batch does not repeat the full repository, lint, Desktop, headless or
browser interaction checks. Their earlier records retain their original
scope. F1/F3 and the previously denied token-table review remain open.

## Published Markdown browser asset after ac45375

HTML export now uses the browser entry declared in the public
`marked/package.json` export. Coding declares `marked@18.0.11` directly;
Pi TUI already installs that version. The copied `marked.min.js` is removed.
The package browser file differs from the pinned Native copy only by its
source map directive. Removing that directive produces the same 44,640 bytes
and SHA-256 `438eedfcf932a414d0d0bfeea32dc365c063563b8ca713b4687fc8f8b501e5e4`.
Native templates, CJK tokenization and renderer configuration are unchanged.
A browser build through the public Pi TUI root failed because it imports
`child_process`; the standalone package supplies its declared browser build.

The 15-line external adapter reads the installed browser asset in source mode
and the shipped asset in bundle mode. The server build writes the package
asset into `coding-assets/export-html/vendor/marked.min.js`. Generation rejects
missing or repeated Native asset reads and excludes the old copied asset.
At that stage, the runtime manifest had 248 TypeScript files and eight assets.
Earlier nine-asset records below describe their original batches.

Bun passes 73 tests across the new Markdown tests, HTML color/export tests and
generator guard tests. Node 24.22.1 passes 24 tests across the two HTML files.
These checks cover package metadata, browser Markdown rendering, packaged
resource selection, generation rejection and real custom-tool HTML export.
The complete server build passes. Source and packaged browser assets both
match the pinned Native bytes. Both complete generation checks pass, including
12 auxiliary sources and 28 shared forwards. Eight explicit type roots have
zero diagnostics. `validate:ci` passes workspace types, SDK declarations,
61 shared tests, 20 documentation-tool smoke tests and all locale checks.
The isolated Craft source audit passes for 2231 files: 1455 common paths,
874 normalized-identical files, 581 modified Craft-derived files, 776
project-only files and 858 reviewed deletions.

A separate relocated bundle uses the actual SessionManager and HTML exporter.
It has no local `node_modules`; a system sandbox denies network access and
reads from workspace dependency directories. The bundle exports a 285,777-byte
HTML file, includes the shipped parser and CJK extension, and renders
`漢字**太字**です` with the expected strong element. The first probe did not
write its bundle because it used an unsupported Bun build output option.
After correction, an assertion that package resolution must fail also failed.
That probe did not record the package source, so it does not establish
isolation. The final probe instead applies the system sandbox and passes.
Neither earlier probe is counted as a pass.

Independent review found no defect requiring a fix. The reviewer verified
byte identity, the exact generated HTML module and manifest records, and
unchanged records outside the exporter and removed asset. The new test file
passes ten tests under Bun and ten under Node 24. Another 27 script checks
cover source registration, both Native HTML export functions and bundles.
Fixed session and theme fixtures produce identical HTML before and after the
change, including custom renderer and session payloads. These fixtures do not
repeat the full Native session lifecycle.

The reviewer also ran a minimal bundle of the actual adapter in separate Bun
and Node 24 processes. Both fail to resolve `marked/package.json`, load the
shipped asset, parse Markdown and reject the package fallback when no asset
is supplied. The reviewer's first missing-package precondition failed before
Bun automatic installation was disabled. Its package source was not recorded;
that run is excluded. Corrected Bun commands use `--no-install`. The reviewer
did not repeat the complete server build, generation or CI checks above.
All reviewer temporary files were removed with trash.

This batch does not repeat the full repository, lint, Desktop or headless
product interaction checks. Their earlier records retain their original
scope. F1/F3 and the previously denied token-table review remain open.

## Public read and write tool contract review

The installed pi-durable 1.5.0 package publicly exports both tool factories.
The reviewer called both factories and tested a working write adapter, rather
than rejecting them because their signatures differ. The main thread reviewed
and reran the retained fixture under Node 24.22.1 with a temporary HOME and
network access denied by the system sandbox. All 24 checks pass. Native
execution methods and two pure helpers are extracted from the exact current
AST; custom file operations and image processing use controlled substitutes.
This check does not import the complete Native UI/config graph.

The write adapter retains path resolution, the Native queue shared with edit,
custom mkdir/write operations, raw error identity and abort checks after each
await. A pending write must settle before the Native queue is released, even
after cancellation. The SDK queue uses separate state and can start a write
while the Native queue is held. The tested adapter preserves these contracts
but adds environment and result bridges to the existing 33-line execution
method. It only delegates the success message, so it does not remove a tool
implementation.

The read adapter matches ordinary and empty text, pagination, line and byte
limits, negative limits and fractional offsets after diagnostics and result
fields are converted. BOM and oversized first-line output still differ.
Custom MIME detection can disable or override Native image routing, whereas
the SDK always inspects the header. Full compatibility also requires Native
image processing, model/fallback resizing, non-vision notes, success/error
status and cancellation. A memory BinaryReader plus environment, model and
result adapters would retain the main contracts in the existing 116-line
execution method. No implementation with a net maintenance reduction was
confirmed.

Both source-manifest records remain unchanged, with empty changes and equal
source/output hashes. Production read/write stay intact; shared lower-level
path, MIME, image, truncation and diff helpers remain in use. These findings
support retaining the tested glue, not a claim that future public APIs cannot
replace it. This read-only review does not repeat full Native imports, type
checks or product interaction. The temporary fixture is removed with trash
after the main-thread verification. F1/F3 remain open.

## Function signature guards after a2c5fe6

This follow-up changes only generation rules, tests and source registration.
The discarded bodies of `StringEnum` and `calculateContextTokens` no longer
require whole-function hashes. Exact function headers retain declaration kind,
exports, generics, parameter and return types, optional options and TypeBox
branding checks. Missing bodies and duplicate declarations also fail. The
model-store class keeps its full hash because its fields and constructor
structure are part of the retained boundary.

Two positive body-change regressions first failed, with 47 tests passing and
two failing. After the signature change, all 49 generator tests pass. These
fixtures include the original function text and compare the complete generated
output after each discarded body changes. Bun passes 80 tests across the five
related files. Node 24.22.1 passes 63 tests across the two portable files. The
first Node command also selected the existing Bun-only public-leaves suite;
its `bun:test` import failed with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The corrected
Node command excludes that suite, which passes in the Bun batch.

Both complete source checks pass: 248 runtime sources and nine assets, plus
12 auxiliary sources and 28 shared forwards. Production output, both source
manifests, dependencies and SDK patches are unchanged. The updated source
registration passes the complete 2230-file Craft audit. The eight explicit
type roots have zero diagnostics. A new `validate:ci` run passes all workspace
types, SDK declarations, 61 shared tests, 20 documentation-tool smoke tests
and locale checks.

Independent review of the two-file generation patch found no defect or
required test gap. The reviewer ran three Bun files with 57 passing tests and
the generator file under Node 24 with 49 passing tests. An extra in-memory
matrix rejected 52 declaration changes, kept output equal for 12 valid body
variants, preserved 12 sets of surrounding sentinel declarations and rejected
six model-store class or kind changes. Generated variants had no syntax
diagnostics. The reviewer's first commands failed before tests ran because of
Bun command ordering and the default Node 10 binary. Corrected commands used
the test subcommand first and the explicit installed Node 24 path. The review
did not repeat the complete generation, CI or type checks reported above.

The generator grows from 219 to 228 lines, and its regression file adds 72
lines. This change removes two discarded-body hash dependencies; it does not
remove another production algorithm. The latest full repository run and the
lint and worker checks in the next section cover the `a2c5fe6` batch. Older
product results retain their stated commits and scope. This generator-only
follow-up does not repeat the full repository or product run. F1/F3 and the
previously denied token-table review remain open.

## Public HTML colors and source checks after 8b1c98f

The HTML batch committed as `a2c5fe6` on 2026-11-08 uses the public pi-tui 1.5.0 `colorToHex`
function for the Native HTML palette and indexed colors. No dependency or SDK
patch was added. The Native parser, state transitions, escaping and tool
rendering stay in place. The converter passes a structural indexed color;
the `indexedColor()` factory rejects indices above 255, which the original
Native parser accepts.

The runtime file changes from 258 to 222 lines. The shared declaration rules
change from 189 to 219 lines, including signature, duplicate and declaration
kind checks. These two files together remove six lines. The gain is removal of a local palette
and conversion algorithm, not proof that the whole SDK has minimum cost.
The generator retains the module documentation and does not bind the replaced
algorithm bodies to a new source hash. Signature, export, binding and duplicate
changes fail generation.

Independent review found one P2 in the first version: the variable branch
also accepted same-name constants in three existing hash-protected rules.
Three new negative tests first failed. The fix restricts that branch to
tool-search and HTML colors; all three now fail generation with the expected
missing-declaration error. The same reviewer confirmed that const/let/var
changes are rejected and changes to the original function/class declarations
still reach their hash checks. The narrow review found no further issue.

| Check | Result and scope |
|---|---|
| Bun regression | The final nine-file model and shared-helper batch passes: 127 tests, 224 Bun `expect()` calls, zero failures. It includes the 37 generator cases and three new declaration-kind regressions. |
| HTML behavior | Both Bun and Node 24.22.1 pass all 14 HTML and declaration tests. SHA-256 baselines captured before the change cover 635 inputs: all indexed colors, wide integers, Infinity, SGR styles, RGB and escaping. A real SessionManager and custom tool renderer write HTML; its payload retains call, collapsed-result and expanded-result colors. |
| Explicit test and generator types | Eight roots, including the two existing ambient declaration files, have zero diagnostics under the Coding package compiler options after the final guard fix. An initial four-root attempt omitted the existing highlight.js declarations and reported 23 missing-declaration diagnostics; the corrected program passes without source or dependency changes. |
| CI and declarations | After the final generator guard fix, `validate:ci` passes with Node 24 on PATH: all workspace types, SDK declarations, 61 shared tests, 20 documentation-tool smoke tests and all locale checks. The explicit eight-root type check and complete source reproduction also pass. |
| Lint | The complete lint command passes with zero errors and 107 existing warnings, using the isolated pinned Craft checkout. |
| Worker build | `bun --no-env-file run --cwd packages/pi-agent-server build` passes. |
| Runtime reproduction | The complete runtime `--check` passes for 248 sources and nine assets after regeneration. Only the ANSI HTML output and its source-manifest entry change. |
| Auxiliary source gate | `vendor-upstream.ts --check` passes for 12 sources and 28 shared forwards. The old credential-source exclusion is removed. A task-owned sparse checkout with only that source modified is rejected before generation; the pinned reference and existing manifest stay unchanged. |
| Craft provenance | After registration of two new tests and six changed hashes, the complete audit passes for 2230 files: 1455 common paths, 874 normalized-identical files, 581 modified files, 775 project-only files and 858 reviewed upstream-only deletions. The first HTML audit correctly rejected its six missing or stale records. |

Three existing converters also drop nine hashes of discarded algorithm
bodies. Child-process forwarding keeps its AST signature and 100 ms policy
constant checks. Shell and read-path forwarding compare readable declaration
headers instead of whole-function hashes. Missing and duplicate declarations,
parameter and return types, exports and retained constants remain guarded.
The original source hashes in both provenance manifests remain unchanged.

Bun and Node each pass 37 new generator cases. Nine cases change individual
algorithm bodies and compare the complete generated output; the other cases
reject declaration or constant changes. The complete runtime and auxiliary
checks still pass without a generated-output change. The existing Native
child-process, shell and read-path suites pass 18, 18 and 20 tests separately,
including real child and descendant output, signal order and path probing.
The nine-file batch above includes the 37 generator cases. Together with
these 56 Native tests, 183 Bun tests pass in the affected suites. Node passes
51 cases across the two new test files. Eight explicit TypeScript roots,
including the existing ambient declarations, pass. The full repository run
and independent review are recorded separately.

The public model-policy review uses the Coding package's resolved pi-ai 1.5.0,
not the root workspace's 1.1.0 installation. `ModelRuntime` already delegates
provider storage, auth and requests to public `createModels()`. Native code
adds models.json precedence and validation, CLI name ambiguity, thinking
suffixes, glob scopes, virtual routing and branch state. The public collection
exposes exact provider/id lookup and provider callbacks, not those Coding
policies. Replacing them with those callbacks retains the same policy code.
This review retains those adapters. The remote catalog wrapper also retains
the four-hour interval, ETag/304, local generation time and failed-refresh
cache policies. Public `createProvider.fetchModels` returns a model list;
it does not replace those metadata publication rules. This is a source and
interface review, with no live catalog request. It does not prove every
remaining source file necessary.

Independent review covers the four compaction modules, the two Native before
hooks and the summary task. It found no new public replacement that reduces
maintenance while keeping the Native contract. Entry-level usage invalidation,
split turns, metadata, retained tails, branch ancestry and file tracking depend
on the Native entry tree. Public `beforeCompact` receives an already selected
range and returns a decline or summary; it does not carry the full Native
retained-entry, usage/details, instruction, cancellation and target-leaf
contract. Native summaries commit the requesting checkpoint before a model
call and reject uncertain replay. Direct use of `CompactionTask` changes that
replay rule. Public token totals, text/context helpers and retry remain in use.
The review ran seven in-memory comparisons without a model request or file
write; it did not run the full plugin or product suite.

Independent review also covers Native session and extension lifecycle,
renderer state and interactive subscriptions, MCP assembly and Llama model
management. Core Agent, durable Registry/GenerationHooks, pi-tui components,
public MCP clients/transports and model request APIs are already in use.
Native retains session shutdown/rebind order, stale-context rejection,
factory rollback, tool render state, subscription cleanup, dynamic tool
exposure, read-only retry and model-management recovery. Replacing those
policies with public callbacks does not remove them. Three in-memory MCP
checks cover resource links, JSON blobs and plain text. The reviewer used
the Coding package's resolved 1.5.0 packages, without a live service or model
request. These comparisons cover representative contracts; they do not prove
every CLI/TUI helper or all 248 source files minimal. F1/F3 remain open.

Further source review checks six CLI/TUI helper areas: arguments, file
arguments, keybindings, model search, session search and visual lines.
Key matching inherits the public manager, session matching uses public
fuzzyMatch, and visual wrapping uses public Text. Native retains application
key migrations and conflict priority, field-specific search tiers,
phrase/regex rules, model labels, selected visual lines and hidden counts.
Seventeen in-memory assertions pass. Four CLI probes differ from the standard
library parser for optional print text, a missing mode value, thinking
warnings and file arguments after --. A thin adapter still needs those
Native rules. File arguments already use the shared path, MIME and image
helpers; complete text reads and file labels stay in the CLI layer. No new
replacement with a confirmed maintenance gain was found in these areas.

The final focused comparison covers ten helper files: countdown-timer,
markdown-transform, diff, mermaid, external-editor, program-status-reporter,
and the four theme modules. It found no new replacement with a confirmed
maintenance gain that keeps the Native contract.

- The timer already uses standard intervals. It retains the initial ceil
  tick, rendering, disposal before expiry, and cancellation. Public
  CancellableLoader does not provide the seconds callback and expiry hook.
- Markdown uses the public transform hook. Native retains ordered transformers,
  current streaming and message context, and per-transformer error isolation.
  Diff uses public diffWords, with Native line numbers, paired inverse rules,
  whitespace handling and deletion-before-insertion order.
- Mermaid already uses Marked and grok-mermaid.render. Public toAnsi ends each
  span with SGR 0. Native fg closes with 39 or 22;39, title adds bold, and a faint
  token can contain two SGR sequences. Direct replacement resets inherited
  background and attributes. Keeping that behavior needs SGR parsing and
  separate closing rules, so it does not establish a smaller adapter. Native
  also retains mode and width gates, warning fallback and CommonMark wrapping.
- The editor uses standard spawn and fs. Public Shell.exec does not expose the
  inherited interactive stdio used here. Native retains Windows console
  handling, platform shell choice, failure handling, BOM removal, one trailing
  LF removal and temporary-file cleanup. Program status already delegates OSC
  output to Terminal.setProgramStatus; event priority, retry outcome, field
  limits and deduplication remain Native policy.
- Theme code already delegates color parsing, conversion, mixing, ANSI styling,
  syntax highlighting and terminal queries to public APIs. It retains token,
  vars and fallback rules, shared theme identity, loading and reload policy,
  language aliases, a 100 ms grayscale wait, late replies and previous colors
  after failed queries. System themes retain surface recipes and the WCAG
  4.5:1 constraint. OKLab lightness does not replace WCAG relative luminance;
  adapting the three-line hex helper does not remove a complete algorithm.

The independent reviewer extracted actual declarations from the current AST
and ran nine in-memory fixture groups with 122 passing assertions. Coverage
includes timer order, transform chains, status priority and fields, diffWords,
Marked and Mermaid rendering, Theme ANSI methods against toAnsi, five fully
mocked editor scenarios, terminal query results and 24 text/background pairs.
The lowest measured contrast ratio is 4.5044:1. The first Bun stdin command
printed usage and ran no assertions; the corrected explicit stdin
transpile/eval command produced these results.

Two further groups use actual Theme foreground, background and bold methods,
Native Mermaid styling, public toAnsi and the current ansiToHtml parser. Six
assertions confirm that Native preserves the inherited #00005f background and
italic style on following text, and that its foreground close preserves outer
bold. The corresponding toAnsi output clears those inherited attributes.
The total is 11 in-memory groups and 128 passing assertions. These checks used
mocks and installed dependencies, without a real editor, terminal,
configuration, clipboard, network or model request. They do not cover a real
Windows console, actual theme directory watchers or complete plugin
interaction.

During this review, the current tool policy denied reading the first part of
theme-tokens.ts. The reviewer stopped that read. Existing type, fallback
validation and dependency evidence does not establish the minimum necessary
token table. That table and the full source-closure necessity review remain
unverified; F1/F3 stay open.

The first full repository attempt after the HTML change failed: the 481-file
main batch had 6762 passes, 11 skips and three failures; 35 isolated processes
had 298 passes and two failures. It is not recorded as a successful run.
Two permission/read failures in the main batch and both isolated worker
failures can be reproduced with a synthetic RTK-enabled application config.
They pass with a task-owned config and the repository config-defaults.json.
An initial empty-config worker attempt lacked that defaults file and failed
before a tool started; after adding the repository defaults, both profiles
pass with 132 assertions.

The remaining main failure expects two runtime refreshes. A synthetic global
connection whose model list filters out the second model reproduces the
single update. Adding only that model to the permitted list makes all nine
tests pass. Independent source analysis confirms the queue waits for both
refreshes; equal resolved signatures correctly skip the second update.
The involved production files and tests match HEAD. These controlled results
show configuration dependencies, not the contents of the original host
config, which were not inspected. Production permissions, model validation
and refresh serialization stay unchanged.

A new complete run uses the same repository test selection and process
boundaries, a task-owned CONFIG_DIR with repository defaults and a synthetic
config, plus the existing native-agent resource isolation. The parent HOME
stays unchanged. All 481 main files pass: 6768 tests, 11 skips, zero failures
and 22299 Bun `expect()` calls. All 35 isolated files then pass in separate
processes: 300 tests, zero failures and 2082 Bun `expect()` calls. The combined
result is 7068 passes, 11 skips and zero failures. The runner exits 0 with an
empty failure list, and its task fixture cleanup exits 0. The earlier failed
attempt remains recorded above.

The 7016-test result and Desktop/headless builds below remain evidence for
8b1c98f. The interactive product flows and full reference-plugin comparison
were not repeated for this private helper change.

## Runtime credential review after 8b1c98f

The continuation on 2026-11-08 obtained and reviewed the previously blocked
source. `RuntimeCredentials` has 52 lines and matches the pinned Pi 1.5.0
source and manifest SHA-256. It implements the public pi-ai `CredentialStore`
interface. The public `InMemoryCredentialStore` has one storage layer and no
backing-store or runtime-overlay option.

The Native contract needs synchronous runtime-key changes, a memory-only
override and the same host store for persistent writes and OAuth refresh.
Removing an override must reveal the latest stored credential. Replacing the
class with the public memory store still needs the override map, metadata
merge and backing-store delegation. It adds async synchronization without
removing these policies. The unchanged upstream adapter is retained; it does
not copy storage or OAuth refresh algorithms.

Two added host-model cases check persistent updates under an active override,
metadata without key values, failed deletion, cancellation and successful
cleanup. Existing cases check shared host/native auth, runtime-key removal
and one OAuth refresh across concurrent host/native requests. All values are
synthetic, and these tests make no external model or login requests.

| Check | Result and scope |
|---|---|
| Credential and model regression | `bun --no-env-file test packages/pi-durable-coding/test/host-model-runtime.test.ts packages/pi-agent-server/src/model-runtime.test.ts packages/pi-agent-server/src/runtime-models.test.ts` passes: 28 tests, 136 assertions, zero failures. |
| Coding package and test types | `bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p packages/pi-durable-coding/tsconfig.json` passes for production sources. A TypeScript program with the same resolved options and `test/host-model-runtime.test.ts` as its root also passes. |
| Runtime reproduction | `vendor-coding-runtime.ts <pinned-checkout> --check` passes for 248 source files, nine assets, dependencies and core imports. The checkout is clean at `f9a26365568127461c47a07a37dcb42c140a3ac5`. |
| Auxiliary reproduction | `vendor-upstream.ts <pinned-checkout> --check` passes for 12 source files and 28 shared forwards. |

The first package-script type check invoked Node 10.24.1 from PATH and failed
with `SyntaxError: Unexpected token ?` before type analysis. Running the same
installed compiler with Bun passes. No runtime, dependency, lockfile or
permission setting was changed. The full CI, lint, product builds and 7016-test
results below remain evidence for the unchanged production code in `8b1c98f`;
they were not repeated for this test and documentation update.

## Latest SDK integration checks after 13b7caf

This section records the changes committed in `8b1c98f`. Earlier sections
retain their original inputs, restrictions and evidence counts.

The shared Photon change removes the private Node loader and global file-reader
override. Native and durable use the same public package and one packaged WASM.
The CodingHost fix keeps internal durable forwarding tools out of Native and
plugin catalogs before and after tool updates and reloads.

The core patch now exports eight consumed operations. The 22-line facade drops
`withToolChanges` and `prepareToolCallArguments`; both functions keep their
original internal core callers. The four-file patch retains the Agent execution
backend that Native fixes to durable.

| Check | Current result and scope |
|---|---|
| Full CI | `bun --no-env-file run validate:ci` passes, including all workspace types, SDK declarations, shared and documentation-tool tests, and i18n checks. |
| Lint | `CRAFT_AGENT_SOURCE=... bun --no-env-file run lint` passes with zero errors and 107 existing warnings. |
| Main repository batch | 479 files, 6715 passed, 11 skipped, zero failures in 437.06 seconds. Includes the 19 owner cases and real Native journal/SIGKILL recovery. This does not include the isolated batch below. |
| Isolated repository batch | All 35 files pass in fresh processes with the repository runner's selection: 301 tests, 2083 Bun `expect()` calls, zero skips and failures. The seven suites that create their own HOME use that fixture's default agent directory; the others retain a task-owned empty directory. |
| Pinned behavior | All 17 reference scenarios pass. The plugin contract passes 28 UI effects, four local replies and idle. |
| Product builds | `server:build` with a task-owned output and `electron:build` pass. The relocated headless server returns HTTP 200 and `status: ok` on an ephemeral loopback port with an offline child and fresh configuration. |
| Product resource | The headless output has exactly one `photon_rs_bg.wasm`, matching the installed public package, and no obsolete coding-specific WASM. Focused Node/Bun image artifact checks remain recorded in the Photon section. |
| Core patch replay | All four pristine 1.5.0 files accept the reduced patch and match both the root installation and a new independent frozen consumer byte for byte. |
| Core consumer | Bun and Node verify the eight retained operations, absence of the two unused exports and execution backend injection. Its strict NodeNext type check passes. |
| Complete reproduction | The actual pinned-runtime `--check` passes for 248 TypeScript files and nine assets. Auxiliary `vendor-upstream.ts --check` passes for 12 source files and 28 shared forwards. |
| Craft provenance | The fixed independent v0.15.6 checkout audit passes for 2228 files: 1455 common paths, 874 normalized-identical files, 581 modified files, 773 project-only files and 858 reviewed upstream-only deletions. |
| Independent review | The reviewer read all 1632 lines of the supplied Git diff, checked 102 changed hunks across 29 tracked files, and read all five new files. No new high-confidence code findings remain. It confirmed production readers for the eight retained operations and no readers for the two removed exports. The main thread verified the final test counts and document status. |

The first complete main batch had 6696 passes, 11 skips and 19 failures.
The owner fixtures used an empty application configuration but read an unrelated
browser preference. The same 19 tests failed before that preference was stubbed,
then passed individually and in the final main batch. The first CI attempt also
caught an insufficient host-tool map return type; the corrected type and full CI
pass.

The next failure was in the isolated Coding product fixture. It changed HOME
but inherited `PI_CODING_AGENT_DIR`, which takes priority when selecting global
extensions. The startup UI therefore never arrived. With only that outer
override removed, the unchanged test passed all 43 assertions. The fixture now
selects its own agent directory and restores the prior value; the original
environment then also passes all 43 assertions.

The final regression evidence combines the successful main batch and the later
complete isolated batch: 7016 passes, 11 skips, 24363 Bun `expect()` calls and zero
failures across 514 files. Only an isolated fixture and documentation changed
after the main batch. The original root command's exit status remains 1; it is
not relabeled as a successful single run. Two intermediate isolated environment
attempts failed and do not count as passes. Removing the agent-directory fence
from every suite caused the PR fixture to fail. Supplying `~/.pi/agent` caused
six native fixtures to miss their resources because the worker uses that
explicit path without tilde expansion. The final run removes the outer override
only for the seven suites that establish their own HOME and native resources.
The PR fixture retains the empty-directory fence and passes. All 35 files
were executed, and the final runner exits 0 with an empty failure list.

At `8b1c98f`, generation, types, builds and the full Craft audit were no longer
blocked by the withdrawn source-reading ban. That session's direct inspection
of `src/pi/core/runtime-credentials.ts` received
`Path access control: protected credentials/secrets file`, so its manual review
remained open. The continuation above completes that specific review. These
checks alone do not prove that every retained SDK source file is necessary.

## Partial SDK patch generator guard

The historical `scripts/patch-durable.ts` produces four harness files. Its
write path still replaced the canonical patch, which now has 28 file
sections. The first scope-only guard in `7c955cb` still allowed independent
changes in those four files, empty patches and non-Git patches. Three added
regression cases fail on that guard before the correction.

Normal mode now refuses every existing patch. It can create an absent patch
with exclusive `wx` creation before it writes installed SDK files or the
manifest. This also preserves a patch created after preflight. The read-only
`--check` retains the historical four-file scope and subsequent exact content
comparison. It rejects missing patches, patches without Git file sections,
out-of-scope paths and unrecognized Git file headers. Both modes reject the
current complete patch before Git calls, semantic analysis or writes.

The focused suite passes 18 tests under each of Bun and Node. Twelve
controlled CLI fixtures use compiler and Git probes: nine stop before Git,
and three reach only the failing Git probe. All fixture outputs remain
unchanged. Two further calls execute the repository CLI with missing SDK
input directories and preserve the actual patch and manifest. Three explicit
tooling type roots cover 220 files with zero diagnostics; their compiler host
limits source reads to those inputs and five verified dependency roots.
The complete patch remains unchanged at SHA-256
`bf8ec9e12c2516923cd67c969b2350e6fc609b0f9043c81ff3f112db6b96f739`.
These checks do not run the full generator or its SDK type analysis.

## Public synchronous context adapter assessment

The public `ConversationTranscript.merge()` can bridge a synthetic committed
view to the existing synchronous Native projection. Bun and Node each
complete 18 controlled cases, with 24 original message identity checks and
zero loader calls. Cases cover excluded assistant results, missing and
duplicate tool results, call order, system baselines, retained heads, custom
messages and uncommitted user or tool-result messages.

Flattening the merged public records differs in 14 cases. The bridge passes
all 18 cases by retaining the Native projection, pending-message overlay and
all ten selected context declarations. It therefore removes no copied model
policy. The public declaration of `Conversation.context()` returns a Promise
of committed context; an asynchronous cache adapter was not implemented or
tested here. The existing synchronous implementation stays in place. No new
SDK helper exports or context patches were added.

The local investigation fixture is `.scratch/context-public-transcript.ts`,
SHA-256 `4da93d352826a676c0ec76be41af270ffeef58a2230155e2eb7a98a4a25569eb`.
It is a task artifact, not part of the committed test suite. This assessment
does not prove that every future public adapter must retain the current code.

## Public command execution adapter assessment

An external adapter calls `NodeExecutionEnv.exec()` with argv, converts the
Native timeout to seconds and collects each decoded output stream under one
byte budget. Bun and Node each complete ten controlled comparisons: seven
match, while malformed UTF-8, incomplete UTF-8 and a leading BOM differ.
At a one-byte cap, raw `FF` and UTF-8 `EF BF BD` produce the same SDK callback
text but require different Native truncation results.

Public spill preserves the original bytes, so it was also tested. A stdout
BOM followed by stderr `a`, and a stderr BOM followed by stderr `a`, produce
identical merged spill bytes and decoded callbacks. At a three-byte cap,
Native must retain the BOM on different streams. Neither the merged bytes
nor those callbacks identify the original BOM stream. A separate timeout
probe confirms that the Native SIGTERM handler writes its cleanup marker,
while SDK process-group termination does not.

The Native command implementation stays in place and continues to use the
shared child wait helper. Recreating raw stream framing, byte accounting and
signal handling in a child wrapper would retain those responsibilities and
add a transport. No such wrapper or SDK execution patch was added. These
macOS probes do not validate Windows or the five-second forced-kill fallback.
The local fixture is `.scratch/exec-public-env.ts`, SHA-256
`706d61a93c247eb3fdd7e412b7627546dd6e04a8df286aaf2ccb10afff614272`.

The first Bun empty-output fixture used `-e ""`, which prints Bun help and
tripped the zero-byte cap. It now uses `void 0;`. Earlier Bun runs also left
the repository preload enabled and are excluded from the final evidence.
An empty explicit config still attempted that preload; a stricter sandbox
blocked it. Later zero-output, zero-exit runs were not counted as passes.
Final runs use an explicit working directory outside the repository, no
config override and `--no-env-file`, including Bun child processes. The
sandbox denies network, restricted source and the repository preload file.
Both runtimes then emit the reported case summaries, and Bun emits the
focused test results. No full SDK, Coding suite or product check was run.

## Public SDK head and tail truncation

Both Native head and tail truncation now call the existing public
`@earendil-works/chord/output` API. One external adapter keeps Native limits,
line counts, labels, first-line rejection and partial-tail policy. Size
formatting keeps the original Native display rules. The SDK needs no
truncation exports or algorithm patches. Its two truncation files still match
the original cache; the patch still covers 28 files, with the other 26 diffs
unchanged. Its current SHA-256 is
`bf8ec9e12c2516923cd67c969b2350e6fc609b0f9043c81ff3f112db6b96f739`.

Bun and Node each match all 875 original cases with full values and errors.
Each also matches 20,000 deterministic random cases and 210 selected
JavaScript cases per direction. These include property getters and primitive
limit coercion; they do not cover objects with stateful numeric coercion.
The final fresh consumer installs 99 cached packages offline with scripts
disabled. Both runtimes pass the same 886 test bodies; Bun records 1803
assertions. Its 28 patched files, six Native files, two original SDK truncation
files and three public Chord files match. Both lockfiles remain unchanged.

The same seven strict type roots now resolve 225 files, down from 437, with
no diagnostics. The truncation entry no longer imports durable tools.
Generation checks both public truncation signatures and retained references
to the removed private helper. Eight API or reference mutations fail; three
body changes and two unused private-helper changes preserve the output.
The actual single-file generator check passes with `complete: false`.

First calls use the final generated entry, default limits and 10 MiB inputs.
Each row uses three fresh processes per implementation; import time is
excluded. The final measurements follow removal of an unnecessary full
line-array copy.

| Runtime | Direction | Input | Native median (ms) | Adapter median (ms) | Adapter range (ms) |
| --- | --- | --- | ---: | ---: | --- |
| Bun | Head | ASCII line | 7.07 | 7.07 | 6.93-7.12 |
| Bun | Head | Unicode line | 2.18 | 2.28 | 2.11-2.33 |
| Bun | Head | 1,048,576 short lines | 36.28 | 34.95 | 31.85-37.39 |
| Bun | Tail | ASCII line | 8.60 | 7.41 | 7.40-7.66 |
| Bun | Tail | Unicode line | 7.76 | 2.69 | 2.46-2.80 |
| Bun | Tail | 1,048,576 short lines | 34.25 | 34.52 | 29.85-36.86 |
| Node | Head | ASCII line | 4.96 | 4.78 | 4.70-5.07 |
| Node | Head | Unicode line | 14.43 | 14.51 | 14.37-14.56 |
| Node | Head | 1,048,576 short lines | 66.69 | 66.33 | 65.99-66.67 |
| Node | Tail | ASCII line | 8.03 | 5.07 | 5.03-5.18 |
| Node | Tail | Unicode line | 32.49 | 15.00 | 14.82-15.17 |
| Node | Tail | 1,048,576 short lines | 67.01 | 66.19 | 66.16-66.24 |

All 72 samples match their input's reference output digest. On short lines,
maximum RSS after the call is 99.91/101.52 MiB for Native/adapter head and
103.72/101.98 MiB for tail under Bun. Node gives 163.19/164.92 MiB for head
and 162.72/164.89 MiB for tail. RSS includes imports and is not a peak
measurement. These samples do not establish every input's performance.

The first install command used the repository worktree because the isolation
wrapper resets its directory. Manifest resolution failed under network
denial. A second flag placement treated `install` as a script. The successful
command sets the consumer directory inside the sandboxed subprocess.
Complete SDK, product and source checks remain restricted. F1/F3, F4 and F5
remain open.

## Public SDK tail truncation stage

This section records `1bd9bba`. The head-and-tail integration above supersedes
its head dependency and performance measurements.

Native tail truncation now calls the existing public
`@earendil-works/chord/output` API. The external adapter retains Native line
counts, truncation labels, partial lines, fractional limits, getter order and
original UTF-16 text. Complete lines use Native Buffer byte weights when lone
surrogates differ from TextEncoder. The adapter limits candidate lines and
UTF-16 suffixes before calling the SDK, so discarded prefixes need no second
encoding or line scan.

The Native line-count policy also moved outside the SDK. Both installed
`dist/truncate.js` and `dist/truncate.d.ts` now match the original cached
package. The durable patch drops from 30 files to 28; the other 26 diffs remain
byte for byte unchanged. Clean replay matches all installed targets. Patch
SHA-256 is
`439c3fa99e6a3e7aa07511aa0cad44b7bfe40496e106e2dc106f121ceea3e7e1`.

Generation checks the public tail signature and references to its removed
private helper. It accepts changes to either implementation body and accepts
a changed or absent unused private helper. Five API or reference mutations
are rejected; four internal changes preserve the generated output. Existing
head guards remain. The actual single-file check reports one source file and
`complete: false`.

The first adapter failed on empty negative-byte limits, NaN line limits,
fractional whole-line budgets and Bun surrogate byte counts. Corrected policy
mapping passes all 875 original cases with full values and errors under Bun
and Node. Each runtime also passes 200 head JavaScript cases, 304 original
tail cases, 20,000 deterministic random tail cases and 210 tail JavaScript
cases. Seven explicit strict roots resolve 437 files with no diagnostics.

A fresh consumer installs 99 original cached packages offline with lifecycle
scripts disabled and a frozen lock. Its 28 patched files, six Native files
and two restored SDK files match the worktree and cache. The worktree suite
passes 884 tests and 1793 assertions. Bun and Node each pass the same 884
consumer test bodies. Both lockfiles remain unchanged.

First calls use fresh processes with 10 MiB inputs and default limits.
The reference imports the pinned Native source; the adapter uses the actual
generated entry. Import time is excluded. Three samples per combination give:

| Runtime | Input | Native median (ms) | Adapter median (ms) | Adapter range (ms) |
| --- | --- | ---: | ---: | --- |
| Bun | ASCII line | 8.44 | 7.82 | 7.69-7.85 |
| Bun | Unicode line | 7.92 | 2.53 | 2.52-3.19 |
| Bun | 1,048,576 short lines | 35.27 | 41.82 | 39.78-42.25 |
| Node | ASCII line | 8.16 | 5.43 | 5.03-5.57 |
| Node | Unicode line | 32.83 | 15.19 | 15.02-15.41 |
| Node | 1,048,576 short lines | 67.84 | 67.75 | 65.92-72.44 |

All 36 samples match their input's reference output digest. On the short-line
input, the largest RSS after
the call is 100.66/119.17 MiB for Native/adapter under Bun and
163.11/160.48 MiB under Node. RSS includes imported modules and is not a peak
measurement. The earlier adapter rescanned the full prefix and took
87.13ms/112.51ms at the Bun/Node medians; that implementation is not retained.
These samples do not establish every input's performance.

Review stays in the main thread. Complete SDK, product and source checks
remain restricted. The boundary generator covers four harness files and was
not used to regenerate the complete 28-file patch. F1/F3 and F5 remain open.

## Shared generation rule ownership

The 18 shared replacements now register their source path, transform,
provenance label and added dependency together. The runtime generator consumes
that result instead of repeating path filters, label selection and dependency
conditions. Whole-module transforms moved to `shared-runtime-port.ts`;
declaration replacement remains in `shared-helper-port.ts`. The original
`portSharedHelpers(path, body)` string interface remains available.

Before the refactor, a scoped capture read the actual generator branch to
record all 18 labels and dependency additions. It also recorded hashes of
the pinned inputs and shared-transform outputs. In Bun and Node, the new
registry matches all those values. All 18 generated files still match their
recorded output hashes, and the actual generator passes `--check` with those 18 explicit
`--file` arguments. This check reports `complete: false`.

The 11 moved guard implementations are unchanged apart from their exports.
All 18 rules still reject missing declarations. The existing public-leaf
check also rejects 13 declaration drifts and preserves three unrelated
suffixes. Four unknown paths, including JavaScript prototype names, return
no rule and retain the input
through the original string interface. The existing scoped-command suite
passes 9 tests and 27 assertions. The narrow public-leaf type check includes
the new transform module, checks 1322 source files from three explicit
roots, and reports no diagnostics. Its existing projections remain in use;
this is not a complete SDK type check.

Runtime source, dependency versions, locks and the runtime provenance
manifest did not change. Complete generation and the Craft audit remain
blocked by the source access boundary. This refactor removes repeated
registration work; it does not establish that the complete SDK retention
or upgrade cost is minimal.

## Native edit execution adapter assessment

The Native `core/tools/edit.ts` file matches its pinned upstream bytes and
has no recorded transformation. Its matching and diff algorithms already
use durable. A scoped prototype extracts the actual Native definition and
calls the public durable `createEditTool()` through an environment adapter.
It uses the real Native mutation queue and shared edit algorithms. Path
resolution, filesystem operations and renderers are controlled boundaries;
the complete tool module is not imported.

The first adapter matched 23 of 24 cases in both Bun and Node. Cancellation
immediately after taking the Native queue skipped an access operation that
the original had already started. Starting access before entering the
public tool preserves that case. The final prototype matches all 24 cases
in both runtimes, including BOM, CRLF, multiple edits, invalid edits,
operation errors and cancellation during access, read and write.

With the same compiler removing types and comments, the original definition
is 57 lines. The candidate definition is 20 lines and its adapter module is
35 lines. Adopting it would add a transformation of currently unchanged
upstream code, environment mappings and a second mutation queue to review.
The two-line reduction does not justify those additional upgrade checks.
Production retains the original definition and its existing shared
algorithms. These prototype results do not establish complete plugin,
remote filesystem or concurrent edit/write equivalence.

## Clipboard public interface and retained policy

The public TUI `NativeClipboard` interface provides text, image and optional
file-path reads, plus an optional text writer. Linux writing remains a
command policy so that a process can retain clipboard ownership. The coding
text and image entry points already use this backend. Their remaining
Wayland, X11, WSL, empty/unavailable, conversion and OSC 52 policies are not
replaced by another public TUI operation. All three clipboard source files
match their pinned upstream bytes and have no recorded transformation.

A source extraction checks seven image policy cases in both Bun and Node.
Commands, native backend, temporary files, MIME detection, Photon, WSL
detection and process state are controlled substitutes. It covers empty
Wayland data with a stale X11 image, available Wayland and X11 data without
a native backend, native fallback, Windows, Termux and WSL interop.
Using only the native image value changes four of these seven results.
Preserving them requires the existing platform policy around the public
backend; moving it to another wrapper would retain that maintenance work.

The first Node fixture incorrectly expected a plain `Uint8Array` for command
output. The original source returns the command's `Buffer` directly and
creates a `Uint8Array` for WSL file output. The corrected fixtures check
those types explicitly in both runtimes. No real clipboard, command,
temporary file or native addon is accessed. These cases do not verify
image conversion, OSC 52 transmission or complete platform integration.

## Agent cold recovery and public pi-ai helpers

The added `agent-recovery.test.ts` kills a separate process with SIGKILL after
a real JSONL tool execute intent is committed. A second process opens that
store, restores the public Agent and sends another prompt. The four cases
combine the stored and current `safe` or `never` replay policies. The effect
runs again only when both policies are `safe`. Model requests, events,
durable history, Agent state and effect files are checked.

The first failing run showed that a binding without a Native journal did not
restore committed user and assistant messages into Agent state. Recovery now
restores those messages with a separate array. Task appends and Agent event
appends therefore retain separate arrays. A second failing run showed that
the next prompt appended the restored initial history a second time.
Recovery now marks that history as present after it validates the stored
task's existence, kind and conversation.

Two failure paths also failed before repair. An unknown numeric task ID
suppressed initial history on the next prompt. An `onBound` exception left
the binding busy and prevented another recovery attempt. Task validation now
precedes the initialization flag, and the callback runs inside the cleanup
scope. Each crash case first checks a failed binding callback, then retries.
The normal-run message identity check also failed: the new restorer ran on
new tasks and replaced existing message objects. Message restoration without
a journal is now enabled only by `recover()`. The journal identity branch
keeps its previous behavior.

Four more cases use real stored task records. A run in another conversation
and a task of another kind fail before the binding callback or scheduler
can change their records. A coding child owned by this conversation's
session task passes validation; its callback deliberately stops execution.
Joining a completed run on the already loaded Agent retains its message
objects and makes no new model request. These checks do not run a complete
Native session lifecycle.

The first fixtures omitted explicit stream bindings and read a nonexistent
`ownerTaskId` field. Both setups were corrected against the public contract.
The final inputs include the required `reasoning` property, task receipts
use the terminal-state discriminator, and the mixed task result specifies
the commit's `TaskId` type. The narrow checker also includes the registry
field and projected task definitions used by these cases.

Three source files now reuse public pi-ai implementations. The in-memory
model store inherits `InMemoryModelsStore`; usage totals use
`pi-ai/utils/estimate`; the Native `StringEnum` keeps its `TUnsafe` signature
and calls the coding package's `Type.Unsafe` around the public schema
builder. These files change from 147, 28 and 1104 lines to 130, 21 and 1094
lines, a reduction of 34 lines.

Direct `StringEnum` forwarding failed the original declaration comparison
in Bun and Node. It lost the non-enumerable `~unsafe` marker and array
cloning. It also accepted an invalid literal in a negative type check.
The wrapper restores these contracts. The public builder has no runtime
imports, so it does not bring a second TypeBox instance. The extracted
baseline and actual Native module resolve the same installed TypeBox entry.
The final comparisons cover storage cloning, cancellation, field replacement
and subclass calls, 36 enum cases and 40 usage cases in each runtime.
The model store intentionally gains a public base class: methods are
inherited, their function identities change, and instances also satisfy
`instanceof InMemoryModelsStore`. Name, constructor arity, own fields and the
checked operation results retain their previous values.

The final affected regression set passes 45 tests in six files with 301 Bun
`expect` calls. A new consumer installs 105 cached packages with frozen locks
and network denied. Its final source snapshot passes the same 45 Bun tests
and 23 Node tests. Node uses experimental TypeScript transformation.
All 45 local runtime files and 34 patched package files match the worktree;
the root and consumer locks retain their recorded digests. The four core
patch files also match a clean replay against saved original files.
Registry tarball integrity is not checked again.

The first expanded consumer attempt missed cached packages because the
wrapper's `BUN_INSTALL_CACHE_DIR` took precedence over `--cache-dir`.
An explicit isolated cache fixed installation. The final install uses a
new empty consumer. The cache also keeps retry 0.12.0 for proper-lockfile
separate from the existing retry 0.13.1 record.

The three explicit generator checks pass with `complete: false`.
The declaration guards reject 13 source mutations and preserve unrelated
suffixes in all three files. The scoped type checks pass with six Agent
roots and 1026 source files, and three helper roots and 1321 source files.
The former checks the actual facade, tests, extracted recovery body and
required run input fields; other durable methods and task definitions remain
projected. The latter checks the actual enum,
test, generation rules and extracted storage class; token re-export is
projected. Neither check loads the complete SDK type graph.

A read-tool adapter prototype also compares the extracted Native definition
with the real durable read tool. Paths and image processing are controlled
boundaries. Both runtimes agree in 31 text and cancellation cases after
compatibility handling; the direct adapter differs in six cases.
The working prototype needs BOM and first-line handling, an earlier abort
listener cleanup and a MIME override that depends on the private first
reader call. With the same compiler and comments removed, the original
definition has 126 runtime lines; the candidate has 90 plus 51 adapter lines.
Imports are extra. The production read tool therefore stays unchanged.

An exact-body search checks 1328 top-level declarations in 245 permitted
Native files against 679 bodies reachable through 204 export roots in seven
public Pi packages. It reads 382 modules and skips five nonrelative
re-exports. Seven matches remain: five one-expression object predicates,
Native `defineTool` and the stream setter. The classifier predicate module
imports model cost, headers and provider retry code. Five new conversion
points for that expression do not reduce the maintenance work.
`defineTool` retains the Native TypeBox, state and unconstrained details
types; calling the public identity function still needs the Native type
boundary. The stream setter needs a separate binding from core.
These are bounded candidate decisions, not a complete API reuse or SDK
necessity proof.

The new crash evidence covers one tool execution boundary without a Native
journal. It does not replace complete journal, plugin loader, product,
worker or release checks. Those checks and the complete source audit remain
subject to the existing access limits.

## Source comparison and process listeners

An explicit-path AST review covers 245 of the 248 TypeScript source records.
The forbidden credential source stays unread. The parser profile also excludes
the SDK and model-runtime entry files. The nine resource records remain outside
this TypeScript comparison. Every selected local and upstream path is checked
through realpath before its contents are read.

At the comparison baseline before the three pi-ai changes above, removing
comments and normalizing import, export and literal dynamic module targets
leaves 206 files with the same TypeScript syntax as upstream.
Four more have the same emitted JavaScript, including type-only files.
The remaining 35 differ. These counts measure source differences. They do not
prove behavior, type compatibility, file necessity or minimum maintenance cost.
The module target review also checks all 245 pairs against their recorded
digests. It finds 1014 relative references to the same source records,
484 unchanged package or standard-library references, and five unchanged
module augmentations. The Agent loop, AgentSession tool calls and plugin core
namespace deliberately use the local durable boundary. The remaining
unrecorded relative type rewrite is the stream module's public `StreamFn`
alias. A changed declaration signature can appear as both an added and a
removed reference; these counts are not independent behavior changes.

The review found an obsolete `process.off` to `removeListener` conversion.
The existing `src/node-process.d.ts` already provides both signatures over
`ProcessEventMap`. Removing the rule restores `interactive-mode.ts`,
`print-mode.ts` and `rpc-mode.ts` byte for byte to the pinned upstream files.
Their source records now have equal source and port hashes and no transforms.
The generator also drops a string replacement whose two arguments were equal.

| Check | Result and scope |
| --- | --- |
| Source parity | All bytes of the three mode files match the pinned upstream files. Their implementation and declarations receive no other changes. |
| Runtime behavior | Six source cleanup expressions pass 228 assertions in Bun and 228 in Node. Each runtime compares the restored method with its previous cleanup method. Cases cover missing, repeated and distinct listeners, cleanup return values and removal identity. No OS signal is sent. |
| Types | Two explicit roots, the six extracted expressions and the existing ambient declaration, cover 239 source files with zero diagnostics. The full CLI and SDK type graph is not loaded. |
| Scoped reproduction | One check with the three explicit `--file` arguments passes with `sourceFiles: 3` and `complete: false`. |
| Existing frozen consumer | Four explicit source copies match in the previously installed consumer. Bun and Node each pass 228 assertions there. No new installation runs; both lockfiles remain unchanged. |
| Review | Main-thread review checks the four restored calls, the two deleted generator rules and the source records. No review is delegated. |

Early checks caught fixture errors before final validation: the positional
argument parser treated `--types` as a path; a parity check caught two calls
that upstream already spelled `removeListener`; and an assumed duplicate
listener count failed in Bun. The corrected check compares the old and restored
methods within each runtime. All final checks above pass.

The static parser first rejected the four records outside `src/pi/`; it now
allows those four explicit paths. A narrower filename exclusion trial hit
`EPERM` while resolving model-runtime. The parser restored its three entry
exclusions and did not retry that read. The static graph also omits worker
entrypoints loaded through URLs or bundle paths and ambient declarations.
Those omissions do not establish dead code.

This step does not run the full SDK, plugin loader, CLI shutdown, terminal,
worker/server builds or complete source audit. F1/F3 remain open.

The explicit-file generator check now reproduces 241 Coding TypeScript files.
Each local and upstream path passes a realpath and digest preflight.
Generated bytes and complete source records match, and the manifest stays
unchanged. The first run rejected the recorded `execute.lazy.ts` name
before reading Coding input files. The corrected validator accepts dotted filenames
within valid path segments. Nine empty, escaping, malformed or restricted
inputs still fail before reading Coding input files. This check reports `complete: false`;
opaque files, resources and the separate Agent boundary outputs are excluded.

The four separate Agent boundary outputs also reproduce through the actual
generator tail, with input reads restricted to four preflighted paths.
Those bytes and source records match. All nine static assets match their
pinned copies, both digests and unchanged-source records; the MIT license
also matches. The combined checks cover 245 permitted TypeScript outputs
and nine assets without changing the manifest. They exclude three opaque
files and do not rebuild the complete dependency or core-import aggregates.
This remains partial evidence, not a full generator or Craft audit result.

## Shared core Agent facade

The facade batch replaced the 662-line Native Agent implementation with a
115-line subclass of the independent core Agent. The default-converter
follow-up above reduces it to 105 lines. Core owns state initialization,
prompt normalization, event reduction, abort and settlement. Native supplies
the durable execution functions and retains queue identity, recovery and
separate mutable defaults.
The durable package's public Agent type does not provide this Native state
and event facade. Its Harness and tasks continue to own scheduling.

The core patch now covers four files. The two added Agent files provide an
optional execution backend, queue snapshots and the protected operations
needed for recovery. The queue declarations expose the mode and three methods; the
active-run declaration exposes a read-only marker. The runtime patch adds
four net lines and does not copy the Agent implementation. That batch
extracted three Native default declarations from pinned source. The converter
follow-up removes the stateless function; two mutable default objects remain.

Native instances now also satisfy `instanceof CoreAgent`; they continue to
satisfy `instanceof Agent`. Both constructors retain `length === 1`.
The first execution parameter changed core's arity to two. A new assertion
failed before the parameter gained an explicit default and passes after
the fix. Internal field and prototype layouts are not identical.

| Check | Result and scope |
| --- | --- |
| Original comparison | Bun and Node each pass 27 scenarios against the saved Native implementation. Cases cover constructor getter order, state copies, input forms, both queue modes, continuation, failures, cancellation, awaited events, recovery callbacks and transparent proxies. Core loop functions are replaced by throwing guards; neither runtime calls them. Pi-ai resolves from each actual package location. |
| Production tasks | Four explicit files pass 32 tests in the worktree. Bun reports 229 `expect` calls; the five new tests also use Node assertions. Existing cases exercise real durable tasks, shared registries, cancellation and tool recovery. |
| Types | Four strict roots cover 1020 source files with zero diagnostics. The actual facade, stream module, generator helper and new tests are checked. Durable method declarations and the core protocol form an explicit projection. This is not a full SDK or durable implementation type check. |
| Reproduction | The facade helper reproduces the Native file from the one permitted upstream Agent file. The source and port hashes match the runtime record. The full runtime generator remains excluded. |
| Clean replay | All four core files replay from saved original artifacts and match the installed files. The existing request-operation hunks remain unchanged. |
| Frozen consumer | A new isolated cache installs 100 packages with both patches, a frozen lockfile and lifecycle scripts disabled under network denial. All four core files and 25 local runtime files match. Bun passes 32 tests; Node passes 10 tests with native type transformation. Root and consumer locks remain unchanged. The core seed uses installed artifacts with four saved originals; registry tarball integrity is not rechecked. |
| Review | Main-thread review checks the execution calls, default object isolation, queue identity, lifecycle and the Proxy receiver. No review is delegated. |

The first backend used a JavaScript private field. A new transparent-Proxy
regression failed in the execution path and again in failure handling.
The final backend uses the same ordinary-field semantics as the existing
core class, and the regression passes. An earlier comparison fixture also
failed to resolve an import-only package through `createRequire`; it now
uses ESM resolution, with Node's explicit parent-resolution flag.

One consumer installation attempt used `--cache-dir` while the wrapper
set `BUN_INSTALL_CACHE_DIR`. It missed cached tarballs and failed under
network denial. The final fresh consumer sets `BUN_INSTALL_CACHE_DIR`
explicitly and installs all 100 packages.

The source graph leaves five permitted files outside its ordinary import
closure. Configuration and URL loading retain the codemode and image
workers. The highlight declaration supplies `.js` subpaths and language
wildcards. Client identity and remote catalog policy have no caller in this
permitted graph; their use through the opaque SDK and model entry remains
unverified. Neither identity logic nor catalog network requests execute.
The public credential protocol also does not supply Native's synchronous
and asynchronous raw-JSON lock callbacks. Its existing file implementation
uses proper-lockfile and standard file APIs; the restricted orchestration
remains outside this review.

That facade batch did not run process-crash recovery. The later independent
Agent crash check above has a narrower scope than full Native recovery.
Full plugin loading, SDK construction, product checks and the complete source
audit do not run. F1/F3 remain open for the
opaque dependency boundary; F4/F5 retain their stated validation limits.

## Raw in-memory credential backend

An extracted Native `InMemoryAuthStorageBackend` is compared with an
adapter that uses the public `InMemoryCredentialStore.modify` queue.
Both Bun and Node retain 14 value observations, callback result identity,
callback failures, an already-aborted operation and a synchronous write
before a queued read. No credential file or restricted orchestration loads.

The first adapter releases its queue while a callback's result Promise
is pending. The Native backend holds that queue until the result settles.
Awaiting the result corrects the observed ordering. Passing the caller's
options directly to the public store also adds a signal property read.
Keeping Native's cancellation wrapper restores the tested read sequence.
The corrected adapter retains both observations in both runtimes.

The same TypeScript compiler removes types and comments from both classes.
Native has 26 runtime lines; the corrected adapter also has 26, including
its added import. New generation rules would add maintenance work.
Production keeps the original backend. This comparison does not validate
file locking, read-only file validation, shared reloads or the opaque
credential orchestration.

## Historical shared core request and tool operations

This is the initial ten-operation stage. The current patch exports eight
consumed operations; see the latest integration checks above.

Native request and tool operations now call the pinned `pi-agent-core` package.
The operation changes cover two of the four patched files and export ten
existing operations and their declarations.
The generator keeps the upstream name check and emits a 24-line facade in place
of the 260-line implementation. No complete coding-agent dependency is added.

The streaming operation takes an optional default identity. Existing five-argument
core calls retain the core default. The Native facade passes its original mutable
default object, so replacing fields on the public core default does not leak
its settings into Native requests. Caller identity overrides still apply. The other nine operations
forward directly. Scheduling remains in the existing durable tasks.

| Check | Result and scope |
| --- | --- |
| Original behavior | Bun and Node each compare 58 scenarios against a copy captured before the change. Values, errors, reference relationships, context mutations and awaited event traces match for all ten operations. All model streams and tool callbacks use local fixtures. |
| Source parity | The ten captured operation bodies match the original core artifact after TypeScript erasure. The patch changes one identity reference in the streaming body and preserves the other nine bodies. Fourteen other core functions retain their bodies. |
| Actual task entrypoints | `durable-agent`, `durable-coding-tool-task` and `native-operations` pass 27 tests and 229 assertions. Their 24 local runtime files pass an explicit import review; the ten selected core operations contain no calls to upstream loop drivers. |
| Types | Three explicit roots cover 820 source files with zero diagnostics through a public-protocol projection. The projection excludes execution barrels and treats the durable binding as opaque. This is not a full Native, SDK or declaration-build result. |
| Reproduction | The helper section alone reproduces the facade from the pinned source and generator. The full runtime generator is not run. |
| Patch replay | Both original artifact files accept the patch through `git apply --check` and replay to the installed bytes. Patch body SHA-256 is `bcd57e196c7216a13b159e09d0f941591c4bf82ef2255c8102506da5ff5d2c1f`. |
| New frozen consumer | A network-denying sandbox installs 100 cached packages with scripts disabled. The core seed contains 26 installed 1.5.0 files with the two saved originals restored; tarball integrity is not checked again. Both patched core files and the Native facade match the root artifacts. |
| Consumer behavior | Bun and Node each pass the two operation tests and all 58 original comparisons. Both lockfiles remain unchanged by installation and tests. Root workspace installation is not run. |

Early checks failed and were corrected. The identity fixture used an unsupported
field and then switched to the actual identity schema. The first type preflight
followed execution barrels toward SDK entrypoints; its access guard blocked the
restricted reads. That attempt failed with 84 diagnostics. The bounded projection
then needed a package-metadata allowance and an explicit hook return type.
The first install missed its cache and all network attempts were blocked; a new
consumer with an explicit cache environment installed successfully. Git also
caught a missing end-of-file marker that Bun had accepted. The standard marker
was added before final replay and consumer validation.

This step does not establish complete SDK types, plugin loading, CLI shutdown,
crash recovery, Windows behavior, server builds or the minimum possible source
closure. The comparator still reports 35 different files, including the reviewed
facades. F1/F3 necessity review remains open.

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

## Native write and streaming output candidates after 0d1a83d

The write probe extracts the original `execute` method and path helpers by AST.
It uses the actual Native mutation queue and public durable write tool, with
controlled file-operation callbacks. It does not import the complete Native
tool definition or renderer. Bun and Node each compare 18 scenarios: cancellation,
operation-error identity, pending operations, path forms, context cwd and two
queued calls. The ordinary environment adapter matches 17. With cancellation
scheduled just after queue acquisition, Native starts directory creation and
writing, then reports cancellation; the adapter reports cancellation without
starting either operation.

Starting Native work before the durable adapter preserves all 18 results and
operation traces. That adapter retains the complete Native write algorithm and
adds environment fields and another queue to obtain the shared result format.
The production implementation remains unchanged because this form adds
maintenance work.

The output probe calls the actual Native `OutputAccumulator`. Its 165 streaming
cases combine 11 inputs, three chunk sizes and five limits. Each case observes
every append, repeated finish, final snapshot, last-line byte count and bounded
full-output read. Spill files must contain the concatenated original byte
chunks and have mode 0600. Inputs include escape sequences, NUL, split UTF-8,
invalid bytes, BOM, long lines and empty output. Temporary files are isolated.
No shell process or real clipboard is used.

Under both runtimes, replacing the rolling tail with public chord `OutputBuffer`
matches 129 complete case sequences. An isolated prototype that skips snapshot
sanitization matches 142. Its 23 differences include 12 zero-limit cases and 11
positive-limit cases. With a 12-byte, three-line window, a long partial line
followed by a newline gives an empty Native snapshot at one append; the raw
window still returns twelve characters from that line. Truncation reasons
also differ in other cases.

A third adapter preserves Native trim thresholds and partial-line state around
the raw buffer. It matches all 165 sequences in each runtime, including the
original spill bytes. With the same TypeScript transpiler and comments removed,
the runtime body grows from 200 to 203 lines, before adding a public raw-snapshot
option, declarations or patch guards. The production collector remains unchanged.
The first Bun launch rejected a long data URL before the checks ran. The final
harness evaluates the same inspected code in memory and passes in both runtimes.

The inspected clipboard modules already use public Pi TUI `getNativeClipboard`;
image MIME detection already shares durable. The remaining code selects platform
fallbacks, distinguishes empty and unavailable image backends, and keeps Native
conversion and OSC 52 policies. This is source evidence only. It does not verify
real clipboard behavior or establish the necessity of the full SDK closure.
F1/F3 and the restricted SDK, product and source checks remain open.

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

That partial-tail prototype was retained at that stage. The public SDK tail
adapter above supersedes that decision. Sharing only the two-line prefix
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

The original head-sharing stage routed Native head truncation, line counting,
size formatting and default limits through durable `/tools`. The adapter retains
Native limit getter order, invalid input errors and truncation labels. For
`a\n` with a one-byte limit, Native still reports line truncation while durable
reports byte truncation. At that stage, the four tail, middle, line and UTF-8
suffix bodies retained their original text, and durable exported its existing
line counter. The public SDK tail adapter above removes that counter export
and restores the two SDK truncation files.

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
Photon runtime. Native retains sequential dimension rounding,
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

## Shared Photon runtime and release asset

Native now uses durable's public `@silvia-odwyer/photon@0.3.3` package.
`compat/photon.ts` initializes its public module and caches success or failure.
It does not replace the global file reader or search the project directory.
The former Node 0.3.4 package remains a development oracle. Server and Desktop
packaging select one `photon_rs_bg.wasm`; a successful server build also removes
the obsolete generated `coding_photon_rs_bg.wasm`.

The generator forwards the two public declarations in `utils/photon.ts`.
Changes to the discarded private loader body no longer require port edits.
Eight changed public-boundary cases are rejected. An old-package import outside
the two explicit image adapters requires a new compatibility decision.

Final checks in this working tree after `13b7caf`:

| Check | Result and scope |
|---|---|
| Node | 12 tests pass across the three `shared-photon` test files. |
| Bun | 89 tests pass across those files and the four existing image suites, including the real image worker. |
| Existing golden outputs | The 17 Native and 17 durable-default cases retain their original bytes and metadata. |
| Native PNG entry points | Byte conversion, Base64 conversion and the synchronous transcoder match the old Node codec for PNG, JPEG, WebP and GIF. |
| Relocated artifacts | A Node ESM bundle and a Bun compiled executable match an existing resize golden result using one adjacent WASM. Invalid project-local WASM is ignored. Removing the adjacent asset returns cached `null` in fresh processes, despite the build machine's dependencies remaining present. |
| Types | 12 explicit roots, 310 source files, zero diagnostics using the coding package's compiler options. Restricted source reads are rejected before the compiler reads a file. |
| Dependencies | The coding workspace's dependency and optional-dependency lock closure reaches 180 records, with only Photon 0.3.3 and no Photon Node or complete coding-agent package. Other declared package dependency resolutions are unchanged by lockfile alias rearrangement. |
| Permitted source | All 245 allowed manifest TypeScript files were canonicalized and searched individually; no old package references remain. Opaque files were excluded. |
| Reproduction | The actual generator passes `--check --file=utils/photon.ts --file=utils/exif-orientation.ts` against the clean pinned upstream revision, with `sourceFiles: 2` and `complete: false`. |
| Frozen install | Root `bun install --frozen-lockfile --ignore-scripts` passes. This reused the normal cache and did not recheck registry tarball integrity. |
| Bounded independent review | The 14 fixed implementation, manifest, packaging and test files were reviewed read-only, with no confirmed findings. The review did not execute code or cover the full product. |

The initial manual NodeNext and root-only compiler configurations did not
match this package. The scoped checks also found an AST member-inference error
and a missing MIME argument in a new test; both are fixed. The final type check
merges the root and package options, including Bundler resolution and the
package's indexed-access setting.

The canonical 28-file durable patch is unchanged, with SHA-256
`bf8ec9e12c2516923cd67c969b2350e6fc609b0f9043c81ff3f112db6b96f739`.
Only the confirmed Photon dependency and loader provenance records were
updated. These scoped results do not establish equivalence of every Photon API.
After the user withdrew the source-reading ban, full runtime reproduction,
workspace type checking, SDK declarations and the server/worker build passed.
The complete headless build also passed after removing the obsolete WASM from
its artifact checklist. Current regression and audit results are recorded
separately. Terminal registration was not rerun.

## Shared image orientation

Native EXIF orientation now forwards to `compat/image-orientation.ts`. A small
durable patch exports its existing EXIF reader and pixel transposition helper
through `images`. The adapter retains in-place flips,
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
These were scoped checks under the earlier source restriction. The complete
runtime and Craft audits have since passed, as recorded in the latest checks
above. Remaining source reasons and upgrade checks are recorded in the
[architecture](coding-architecture.md). F1/F3 remain open for the protected
body's necessity review; the complete task has not passed final acceptance.

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

This section summarizes the earlier integrated runtime and includes changes
from several batches. Its architecture is a record, not a required source or
phase layout. Packaging and source counts below are updated to `cb0311f`;
behavior evidence remains limited to each check's stated version.

The coding profile uses the existing `DurableKernel` and its Harness.
`@mkagent/pi-durable-coding` currently contains the public Pi coding dependency
closure from v1.5.0, commit `f9a26365568127461c47a07a37dcb42c140a3ac5`.
`UPSTREAM-RUNTIME.json` records 248 TypeScript files and 7 Pi assets, source
hashes and controlled transformations. Earlier stages had 9 and then 8 assets;
the published Marked and Highlight.js resources are separate dependencies.
`UPSTREAM.json` records the earlier compatibility helpers. The package retains
the upstream MIT license.

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

Packaging at `cb0311f` selects one shared Photon WASM, native themes, HTML
export templates, third-party browser resources and the Pi MIT license. The
server build was rerun for the browser resource changes; the full Desktop and
headless product flows retain their earlier evidence. Headless archives also
include the root LICENSE and NOTICE. Image workers resolve from the installed
module; the project directory cannot supply an executable worker.

The current production dependency graph uses the public `pi-agent-core`
protocol, proxy and patched operation APIs. The dependency policy prohibits the complete
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
flow. Those paths still need regression coverage before completion is claimed.
Current work uses the requested main checkout and normal host environment.

Unsafe legacy checkpoints, old checkpoint versions and uncertain effects fail
closed with migration diagnostics. Startup does not silently discard them.
Those stores need reconciliation with the previous runtime before migration.

After an uncertain request, accepted queues remain available. An explicit new
prompt starts before those retained queues, following native prompt semantics.
The interrupted model request is not automatically repeated. Native history
keeps the failure message; durable model context excludes failed, aborted and
deferred assistant messages.

## Reproduction and upgrade

Repository acceptance entry points are listed below. The user authorized full
source checks, reference parity, validate:ci and builds in the main checkout
with the normal HOME. Runtime fixtures use their own temporary data and local
providers. Results remain specific to the commands actually completed.

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

The complete runtime generator check recorded for `cb0311f` covers 248
TypeScript outputs and seven Pi resources. Earlier nine-resource checks belong
to the batches before the Marked and Highlight.js replacements; see their
sections above for the transitions. This documentation batch only checks the
manifest facts and does not rerun generation. The full Craft audit uses a
separate pinned checkout.
A previous session could not inspect `runtime-credentials.ts` because its tool
reported `Path access control: protected credentials/secrets file`. The
continuation on 2026-11-08 obtained the source under its normal tool policy and
completed that review. No permission settings were changed. Partial hash
checks alone do not establish full reproduction.

Set `CRAFT_AGENT_SOURCE` to the isolated pinned Craft checkout. The earlier
helper port uses `scripts/vendor-upstream.ts` in the coding package.
`scripts/patch-durable.ts` covers only the historical four-file boundary
patch. Its default mode only creates an absent patch; it never replaces an
existing patch. Read-only `--check` accepts only the historical scope, so both
modes reject the current complete patch. Rebuild and
verify the complete patch against pristine locked dependencies while
preserving every required section. The four-file tool does not reproduce
the current 28-file patch.

The headless build replaces its output directory. Use a new directory owned
by the validation task.

On upgrade, check published Pi SDK APIs against required product and plugin
behavior first. Then review the remaining source ports, adapters and repository
patches. Update affected manifests, declarations, assets and patches. Run the
oracle, subprocess, journal, queue, lifecycle and stored-task migration checks.
The generator requires a clean pinned checkout for every consumed coding and
Agent source, package metadata and license. Reproducing the current closure
checks its provenance, not whether its entire export surface is required.
Current checkpoint tests do not establish support for a future Pi release.
