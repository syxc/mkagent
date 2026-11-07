# Pi-durable coding agent capabilities and Pi extension compatibility

## Baseline and goal

The runtime is named `pi-durable coding agent`, also called `durable coding
agent`. It combines pi-durable execution with the coding capabilities and
plugin ecosystem of Pi coding agent. All existing MkAgent product features
must remain complete and work through Desktop, WebUI, CLI and headless entry
points. The upper-layer source is the compatibility baseline.
The baseline is MkAgent `85325251a10d`, whose tree matches `0959d3563892`.
The source baseline is Pi v1.5.0, commit
`f9a26365568127461c47a07a37dcb42c140a3ac5`. The coding package's Pi dependencies
are pinned to 1.5.0. The existing shared transport retains pi-ai 1.1.0.
The upstream `main` sources are review inputs:

- https://github.com/earendil-works/pi/tree/main/packages/durable
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent
- https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent

The user requests complete coding capabilities, independent modules, official
package reuse, real functional validation, and the best possible compatibility
with existing Pi plugins. Compatibility must describe tested API behavior.
Loading a plugin without exercising its operations does not establish compatibility.

The user's clarification on 2026-11-04 permits `pi-agent-core` where needed.
Production must not depend directly on the complete `pi-coding-agent` package.
This clarification replaces the earlier dependency restriction in this document
and in the historical first-switch specifications.

On 2026-11-06, the user considers most required functionality implemented and asks for that
assessment to be checked against code and behavior evidence. Existing code and
historical checks establish the kernel integration. The current priority is
architecture: prefer public package imports, use thin external adapters where
needed, and minimize source ports and internal changes that increase upgrade
work. Verify those facts against code and tests before changing an implementation.
Existing functionality and plugin contracts remain the regression baseline.

This inventory is the acceptance target. Its baseline column describes MkAgent
before this migration. See [validation and limits](coding-validation.md) for
the implemented behavior and current evidence. Follow the ordered corrections
and product acceptance gates in the
[implementation plan](durable-coding-agent-plan.md).

## Architecture

The target assembly is MkAgent product features above durable coding agent,
whose Coding layer uses the existing pi-durable kernel. Requiring every normal
session to use AgentSession or a native projection is an implementation choice,
not a separate acceptance condition.

`@mkagent/pi-durable-coding` contains the ported resource, prompt, extension,
session projection and presentation code. It depends on independent official
Pi packages. It has no dependency on
MkAgent shared code, Electron, the subprocess implementation or UI components.
The subprocess supplies narrow callbacks for session operations and permissions.

The existing `DurableKernel` owns the Harness and production storage. The native
`AgentSession` supplies coding behavior. A durable Agent facade and the
`pi.coding.session`, `pi.coding.run` and owned tool tasks schedule its callbacks.
Retries, compaction, nested execution and settlement return through those tasks.
The old Agent loop is excluded from the source closure.

Normal and coding profiles retain their existing prompts, tool visibility,
permissions and resource policies. Runtime selection and Pi resource loading
are separate concerns. A shared runtime must not make normal sessions load
ambient Pi settings, extensions, skills or system-prompt files. Distinct durable
task types are allowed when they serve different operations; acceptance checks
execution ownership, capabilities and product behavior.

Reuse the native `SessionManager.inMemory()` and projection functions for
synchronous extension reads and previews. Production writes go through durable.
Custom entries, messages, labels, context edits and compaction changes need
commit barriers before the next request, settlement, fork, reload and shutdown.
Stable native JSONL paths are rebuilt from committed journal snapshots. A
companion manifest preserves the active leaf, entry mappings and revision.
These files support native path APIs and import/export. They do not own
execution or recovery, and the native JSONL writer stays disabled.

The server combines builtin, extension, web, proxy and MCP tools, then applies
the existing host permission wrapper to every tool. Native `tool_call` handlers
run before final host approval. Nested plugin calls use durable `executeTool`,
which invokes the same validation and approval path. Native `details` and
`structuredContent` have distinct mappings; neither is silently discarded.

Resource and extension operations are applied at idle turn boundaries. The
effective prompt contains the host base prompt, project instructions, skill
catalogue, append instructions and active tool guidance. Context transforms run
before cache warming so warming and generation use the same request.

## Official package decision

Use durable public tools, environment, images, codemode and tool-search APIs.
Keep the existing cancellation fixes in local grep/find/ls until an equivalent
official implementation is verified.

Do not add the complete `pi-coding-agent` package as a production dependency or
load its runtime through a subpath. Use independent official Pi packages where
they fit. `pi-agent-core` may supply public types or reusable operations where
needed, but pi-durable remains responsible for execution scheduling, task
ownership, accepted inputs, recovery and commits. Importing an official package
must not start a second Agent loop outside that boundary.

The current implementation uses public `pi-agent-core` protocol types and
`streamProxy`. The local Agent facade and durable tasks own execution.
Reassess source-port adapters when another public core API can replace them
without changing durable execution.

The current implementation ports the public coding dependency closure from
the pinned TypeScript source. This is an implementation record, not a
requirement to copy that entire closure. For each retained area, identify the
required contract, the public interface gap and why an external adapter is
insufficient. Preserve registration, event chaining, rollback and stale-context
behavior when replacing or reducing a port.

`UPSTREAM-RUNTIME.json` records each source and output hash, asset and
transformation in the full runtime port. `UPSTREAM.json` records the earlier
compatibility helpers. The user has withdrawn the earlier source-read restrictions
and authorized full generation, type checks, tests and builds in the designated
workspace. Respect tool-enforced access rejections and record their actual scope.
The helper generator can reproduce its explicit source list. The runtime keeps
TypeScript declarations and binds Agent execution imports to the durable facade.
Host consumers use `./native`, `./agent` and
`./durable` exports.

Plugin SDK import identifiers resolve to the local port or independent official
packages. Resolving a plugin's `pi-coding-agent` SDK identifier does not authorize
loading the complete package. A compatibility export list describes implemented
runtime exports; it is not a full compatibility claim.

## Durable boundary requirement

Native `turn_end` and `agent_before_settle` handlers can refer to a committed
message entry, return context edits and custom entries, and request continuation.
Durable 1.5.0's `onYield` runs before final answer persistence; `afterRun` runs
after input settlement. Neither hook alone preserves this protocol.

The coding runtime uses its own versioned durable tasks for these boundaries.
The journal commits native drafts, accepted queue identities and the next
checkpoint together. Request intent precedes context transforms and streaming
callbacks. Recovery does not replay uncertain callbacks or unsafe tools.
The legacy durable patch remains for non-coding tasks and migration.
New checkpoint phases require task-version and recovery checks. External plugin
effects do not have an exactly-once guarantee.

## Capability inventory and acceptance

| Capability | Baseline | Required verification |
| --- | --- | --- |
| read/write/edit/bash | Official durable tools | Real filesystem, exact/failed edits, exit, timeout, cancellation |
| grep/find/ls | Local 1.1 adaptations | Versioned schema/output comparison, ignore rules, Unicode, limits, abort |
| Images and long output | Photon, output windows and spills | Packaged WASM, image read, truncation and recovery |
| PowerShell | No native named tool | Platform availability, real execution where available; record platform limits |
| Permissions and metadata | Host handshake | Allow, deny, modified paths, nested calls, zero denied side effects |
| Project instructions | Host cwd/descendant path list | Global and ancestor content, override precedence, deduplication |
| SYSTEM/APPEND files | Absent in durable entry | Explicit composition; host safety and identity remain in effect |
| Native skills | MkAgent skills only | Official parsing, native/explicit paths, collisions, disabled model invocation |
| Skill activation | MkAgent mention prerequisites | Native commands, shared discovery and successful-read prerequisites |
| Prompt templates | Absent | Official resource parsing, quoting, defaults, slices, collision and unknown commands |
| Extensions: tools | Absent | Unmodified TypeScript plugin, schema, structured output, abort, nested calls |
| Extensions: commands/input | Absent | Native command precedence, transform/handled, reload without duplicates |
| Extensions: events | Absent | Session/run/message/tool events and observable handler effects |
| Extensions: context | Absent | Before-start prompt changes, request context transformation, cache consistency |
| Extensions: state | Absent | appendEntry, labels/name, committed restore and fork-aware state |
| Extensions: models | Host model runtime | Registry reads, provider registration and current-model/thinking changes |
| Extensions: session control | Host sessions | Explicit support or error for new/fork/tree/switch; never false success |
| Extensions: UI | MkAgent UI | Report mode/hasUI accurately; terminal components require a TUI host |
| Local package resources | Absent | Official manifest discovery, filters, source diagnostics, offline load |
| npm/git package management | Absent | Explicit installation only; no implicit downloads while opening a project |
| Project MCP | Loader exists, trust not wired | Explicit host trust; no process before approval; reject project credential routing |
| MCP OAuth | Explicitly unavailable | Separate host authorization integration; do not count refresh as interactive login |
| Codemode/tool search | Official durable extensions | Extension tools discoverable; removal and exposure changes take effect |
| Retry/steer/follow-up/compaction | Durable | Existing real Harness regressions remain green |
| Resume/branch/usage/export | Durable plus host | Restore and branch state without replaying completed file mutations |
| CLI/JSONL/Desktop/WebUI | MkAgent transports | Real packaged subprocess and headless CLI execution; UI-specific limits recorded |
| Themes/shortcuts/editor/renderers | Native TUI concern | Retain diagnostics and document unsupported terminal-only behavior |

Plugin compatibility is assessed per API group. A retained source file or a
successful registration does not establish all host, platform and interactive
workflows. See the validation report for tested behavior and host limits.

Confirmed missing required host operations remain acceptance defects. Missing
validation is an evidence gap, not proof of a missing implementation. Record
both separately and retain unverified scope without extending this architecture
work to every possible plugin or platform combination.
MkAgent regression coverage must also include model and credential updates,
permissions, proxy and session tools, MCP, browser tools, background work,
branching, persistence and transport behavior.

## Trust and configuration

The host passes explicit directories and profile. Do not change process HOME
or read the user's Pi auth file. Use the host's existing credential store and
model catalog. Project Markdown is data; it cannot grant executable trust.
Project extensions, executable packages and MCP require a host approval that
identifies the canonical project and executable resource configuration.
Project-local `trusted: true` is not an authorization source.

Load global MkAgent resources from its agent directory and native project
resources from `.pi`. MkAgent workspace and `.agents` skills remain usable.
Resolve installed local package resources from their Pi manifest. An explicit
package management operation is required to fetch or install dependencies.

Trusted Node plugins can access filesystem and network directly. They are not
sandboxed by the tool wrapper. Denial must happen before module import.
Clients without a responder report `hasUI: false` and use native cancellation
defaults for dialogs. Terminal component factories require a TUI host.
Shutdown and reload release old handlers and connections.

## Implementation sequence

The first implementation followed the historical sequence below. It established
the source port and main durable integration. The current work follows the
[architecture follow-up](coding-follow-up.md): first correct and check the
documents, then verify the implementation and package alternatives, implement
the confirmed reductions, and validate their effects. Check each result against
the user's requirements and correct unsupported assumptions as they appear.

1. Commit this versioned design and inventory.
2. Port the native resource and extension dependency closure with provenance.
3. Bind native resource/input/prompt behavior, tools and session projections to durable.
4. Connect host trust, native skill discovery and plugin event/model callbacks.
5. Verify actual file editing and shell checks through a local deterministic model,
   including allow/modify/deny, nested calls, cancellation, restore and reload.
6. Implement and test the durable boundary stage and remaining session/provider bindings.
7. Build and run the bundled JSONL subprocess outside the source tree, then run
   required repository checks. Record results and remaining compatibility limits.

Commit `4776fe1` records that implementation and its source audit. Its checks
are evidence for that commit, not proof that the clarified target is complete.
No push, pull request, merge, paid model request or production service changes
are authorized by this task.

## Upgrade, performance and rollback

Keep the Pi dependencies on matching exact versions. On upgrade compare public
exports, extension actions/events, tools, resource behavior, package resolution,
bundle assets and runtime side effects. Test unmodified plugin fixtures against
the new version. Reject unsupported operations explicitly.

Resource snapshots avoid full repository scans on every tool call. Reload at
an idle boundary replaces the snapshot and tool registration set. The host
transport DTOs do not import upstream runtime types.

Rollback requires a runtime that understands the stored task versions and
migration fence. Disabling the integration alone does not transfer accepted
work back to the old scheduler. Durable entries remain the source of truth;
unsupported checkpoints require explicit reconciliation before migration.

## Validation isolation and evidence

Run checks in the designated workspace with the normal HOME and network environment.
Tests use temporary data/config directories, random loopback ports and deterministic
local providers. Recovery and reference fixtures may set their child process HOME
to their own temporary directory. Do not use the live WebUI on port 9100, closed
browser tasks 7 or 8, real credentials or the real Craft checkout.
Use an independent pinned Craft checkout for the source audit.

The final validation report must separate unit/contract coverage, real Harness
behavior, packaged subprocess behavior and platform checks. It must list every
inventory row that remains incomplete. Historical green runs do not establish
that current changes pass. Evidence for unchanged areas may be reused when the
report states its commit, coverage and reason it still applies.
