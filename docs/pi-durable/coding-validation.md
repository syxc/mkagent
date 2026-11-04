# Durable coding validation and limits

## Implemented scope

The coding profile uses the existing `DurableKernel` and its Harness.
`@mkagent/pi-durable-coding` contains the complete public Pi coding source
closure from v1.5.0, commit `f9a26365568127461c47a07a37dcb42c140a3ac5`.
`UPSTREAM-RUNTIME.json` records 249 source files, 9 assets, source hashes and
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

The production dependency graph excludes `pi-coding-agent` and `pi-agent-core`.
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

## Capability boundaries

Retaining native source does not establish all host and platform combinations.

| Inventory area | Behavior and limits |
| --- | --- |
| read/write/edit/bash | Production tools keep host approval. Native implementations and public SDK exports are retained. Filesystem, approval and timeout regressions use local fixtures. |
| grep/find/ls | Host tools keep their cancellation adaptations. Native SDK tools remain available. Cross-platform Unicode and ignore-rule combinations are not all exercised. |
| Images and long output | Native image conversion, truncation and output code are retained. Relocated native PNG processing and durable BMP reads use their respective packaged WASM files. Every spill and recovery combination is not exercised. |
| PowerShell | Sources are retained. Windows execution was not exercised. |
| Permissions and metadata | Allow, deny, modified arguments, nested calls, visibility and durable ownership have coverage. Trusted Node plugins are not sandboxed. |
| Project instructions | Native parsing and source identity are retained. Project execution requires host trust. Host-rendered and native instruction deduplication still depends on shared source metadata. |
| SYSTEM/APPEND files | Native precedence and composition have coverage. The host base prompt remains present. |
| Native skills | Native parsing, explicit invocation, collisions and installed resources have coverage. |
| Skill activation | Native expansion is retained. Every shared mention and successful-read prerequisite combination is not exercised. |
| Prompt templates | Native parsing, quoting, defaults, slices, collisions and input transforms have coverage. |
| Extensions: tools | Unmodified plugins, structured results, nested calls, progress, cancellation and deferred discovery have coverage. |
| Extensions: commands/input | Native command and input processing are used. Production reload and handled-input cases have coverage. |
| Extensions: events | Native run, turn, message, tool and settlement events are retained. Oracle scenarios check order and effects. Crash tests check uncertain delivery. |
| Extensions: context | Native transforms, boundary drafts and journal projection are used. Complex mixed provenance combinations are not all exercised. |
| Extensions: state | Custom entries, labels, IDs, committed restore, edits and forks have coverage. |
| Extensions: models | Host models, extension providers, virtual models, selection, reload, reopen and auth availability have coverage. Interactive OAuth was not exercised. |
| Extensions: session control | Native APIs are retained. Production managed operations use host bindings. Every navigation, fork and concurrent close combination is not exercised. |
| Extensions: UI | Production reports print mode and no interactive UI. Native TUI sources remain available to SDK consumers. |
| Local package resources | Native installed-manifest discovery, filters and diagnostics are used. |
| npm/git package management | Opening host resources does not install missing packages. Explicit installation workflows are not all exercised. |
| Project MCP | Project execution requires explicit host trust. A product trust-approval UI is not part of this migration. |
| MCP OAuth | Production interactive authorization is not provided. |
| Codemode/tool search | Official host integrations and native tools share durable execution. Dynamic catalogs, deferred activation and handoff context through restart have coverage. |
| Retry/steer/follow-up/compaction | Native callbacks use durable phases. Accepted queues, cancellation, repeated text, retry deadlines and compaction thresholds have coverage. |
| Resume/branch/usage/export | Journal and legacy projection tests cover history, edits, branches, forks and usage. Native HTML export works with relocated templates and themes. All combinations of multiple heads and managed navigation are not exercised. |
| CLI/JSONL/Desktop/WebUI | Packaged subprocess and JSONL checks run locally. The macOS arm64 headless launcher, health endpoint and authenticated WebSocket were exercised. Real Desktop and browser interaction were not exercised. |
| Themes/shortcuts/editor/renderers | Native sources and resources are retained and packaged. Interactive terminal behavior was not exercised. |

Unsafe legacy checkpoints, old checkpoint versions and uncertain effects fail
closed with migration diagnostics. Startup does not silently discard them.
Those stores need reconciliation with the previous runtime before migration.

After an uncertain request, accepted queues remain available. An explicit new
prompt starts before those retained queues, following native prompt semantics.
The interrupted model request is not automatically repeated. Native history
keeps the failure message; durable model context excludes failed, aborted and
deferred assistant messages.

## Reproduction and upgrade

Use an isolated environment and a pinned Craft mirror:

```sh
bun test ./packages/pi-durable-coding ./packages/pi-agent-server
bun packages/pi-durable-coding/test/reference/parity.ts \
  <isolated-upstream-node-modules> <pinned-Pi-checkout>
bun packages/pi-durable-coding/scripts/vendor-coding-runtime.ts \
  <pinned-Pi-checkout> --check
bun run validate:ci
bun run lint
bun run audit:craft-reuse
bun run --cwd packages/pi-agent-server build
bun install --frozen-lockfile --ignore-scripts
bun run server:build --output <task-owned-output-directory> --compress
```

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
