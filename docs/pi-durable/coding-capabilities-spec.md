# Durable coding capabilities and Pi extension compatibility

## Baseline and goal

This design ports the Pi coding agent's upper layers and replaces its Agent
kernel with pi-durable. The upper-layer source is the compatibility baseline.
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

This inventory is the acceptance target. Its baseline column describes MkAgent
before this migration. See [validation and limits](coding-validation.md) for
the implemented behavior, current evidence and limits.

## Architecture

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

Reuse the native `SessionManager.inMemory()` and projection functions for
synchronous extension reads and previews. Production writes go through durable.
Custom entries, messages, labels, context edits and compaction changes need
commit barriers before the next request, settlement, fork, reload and shutdown.
The native JSONL writer remains an import/export concern.

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

Do not depend on the `pi-coding-agent` or `pi-agent-core` packages, including
their private files. A probe importing only resource exports bundles 2,074 modules
and about 9.0 MB of uncompressed code. The user explicitly rejected this route.
The historical ban on those runtime dependencies remains in force.

Port the complete public coding dependency closure from the pinned TypeScript
source, including the SDK, resources, extensions, session layer and presentation
code. Preserve registration, event chaining, rollback and stale-context behavior.
Controlled port scripts bind execution, model credentials, resource trust and
effective settings to the host.

`UPSTREAM-RUNTIME.json` records each source and output hash, asset and
transformation in the full runtime port. `UPSTREAM.json` records the earlier
compatibility helpers. The generation scripts reproduce both from the pinned
checkout. The runtime keeps TypeScript declarations and rewrites old Agent
imports to the durable facade. Host consumers use `./native`, `./agent` and
`./durable` exports.

Plugin import identifiers resolve to the local port or independent official
packages. They must not fall back to the old engine. A compatibility export
list describes implemented runtime exports; it is not a full compatibility claim.

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
No-UI clients return explicit unsupported results for interactive operations.
Shutdown and reload release old handlers and connections.

## Implementation sequence

The migration followed this sequence. The validation report records the tested
behavior and the platform and interactive workflows that remain unverified.

1. Commit this versioned design and inventory.
2. Port the native resource and extension dependency closure with provenance.
3. Bind native resource/input/prompt behavior, tools and session projections to durable.
4. Connect host trust, native skill discovery and plugin event/model callbacks.
5. Verify actual file editing and shell checks through a local deterministic model,
   including allow/modify/deny, nested calls, cancellation, restore and reload.
6. Implement and test the durable boundary stage and remaining session/provider bindings.
7. Build and run the bundled JSONL subprocess outside the source tree, then run
   required repository checks. Record results and remaining compatibility limits.

The final migration commit includes source audit entries and validation for the
complete runtime.
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

All tests use the task worktree, temporary HOME/config, environment allowlist,
random loopback ports and deterministic local providers. Do not use the live
WebUI on port 9100, browser space 7, real credentials or the real Craft checkout.
The isolated pinned Craft mirror is the source-audit reference.

The final validation report must separate unit/contract coverage, real Harness
behavior, packaged subprocess behavior and platform checks. It must list every
inventory row that remains incomplete. Historical green runs are not evidence
for this branch.
