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
priority is package reuse and thin external adapters that reduce upgrade work.
The [follow-up list](coding-follow-up.md) records the revised work and the
blocked source checks. Normal-profile AgentSession and projection requirements
were unsupported assumptions; the candidate runtime changes were withdrawn.
The baseline product test then passed with 1 test and 43 assertions.

## Current shared implementation follow-up

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
