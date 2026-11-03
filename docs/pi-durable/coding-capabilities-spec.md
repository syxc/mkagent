# Durable coding capabilities and Pi extension compatibility

## Baseline and goal

This design extends the durable kernel with a separate coding capability package.
The baseline is MkAgent `85325251a10d`, whose tree matches `0959d3563892`.
Both upstream packages are pinned to 1.5.0. The upstream `main` sources are
review inputs, not a moving production dependency:

- https://github.com/earendil-works/pi/tree/main/packages/durable
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent
- https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent

The user requests complete coding capabilities, independent modules, official
package reuse, real functional validation, and the best possible compatibility
with existing Pi plugins. Compatibility must describe tested API behavior.
Loading a plugin without exercising its operations does not establish compatibility.

## Architecture

`@mkagent/pi-durable-coding` owns resource loading, input expansion and native
extension adaptation. It depends on public Pi APIs. It has no dependency on
MkAgent shared code, Electron, the subprocess implementation or UI components.
The subprocess supplies narrow callbacks for session operations and permissions.

The existing `DurableKernel` owns the Harness, model loop, storage, recovery,
branching and compaction. Native `Agent` and `AgentSession` must never be created.
An official in-memory `SessionManager` may project committed durable entries for
read-only extension access. It must never become a second persistent transcript.
Extension state is committed into the durable conversation and restored from it.

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

Use `pi-coding-agent@1.5.0` public exports for native resource parsing, package
resolution, extension loading and `ExtensionRunner`. Private deep imports are
prohibited. A probe importing only resource exports bundles 2,074 modules and
about 9.0 MB of uncompressed code. The package also installs agent-core and TUI.
The public export layout prevents a small isolated extension import.

This revises the historical switch specification's ban on the coding-agent
dependency. The invariant is now one durable agent runtime, rather than absence
of transitive agent-core code. Official reuse reduces the maintenance of the
rapidly changing extension API. Exact version pins, bundle smoke tests and an API
compatibility matrix control this cost.

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

Plugin compatibility is assessed per API group. Terminal rendering, unsupported
session navigation and virtual model routing cannot be advertised as complete
compatibility merely because their registrations load.

## Trust and configuration

The host passes explicit directories and profile. Do not change process HOME
or read the user's Pi auth file. Use the host's existing credential store and
model catalog. Project Markdown is data; it cannot grant executable trust.
Project extensions, executable packages and MCP require a host approval that
identifies the canonical project and executable resource configuration.
Project-local `trusted: true` is not an authorization source.

Load global MkAgent resources from its agent directory and native project
resources from `.pi`. MkAgent workspace and `.agents` skills remain usable.
Resolve package resources through the official package manager with missing
sources skipped. An explicit package management operation is required to fetch
or install dependencies.

Trusted Node plugins can access filesystem and network directly. They are not
sandboxed by the tool wrapper. Denial must happen before module import.
No-UI clients return explicit unsupported results for interactive operations.
Shutdown and reload release old handlers and connections.

## Implementation sequence

1. Commit this versioned design and inventory.
2. Add the independent resource and extension package, using official public APIs.
3. Connect resource/input/prompt composition, extension tools and durable state.
4. Connect host trust, native skill discovery and plugin event/model callbacks.
5. Verify actual file editing and shell checks through a local deterministic model,
   including allow/modify/deny, nested calls, cancellation, restore and reload.
6. Build and run the bundled JSONL subprocess outside the source tree, then run
   required repository checks. Record results and remaining compatibility limits.

Each feature commit includes its source audit entries and relevant validation.
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

Rollback disables the compatibility package at the server integration boundary;
durable session entries remain the source of truth. New extension entries must
not prevent older kernels from reading the remaining conversation.

## Validation isolation and evidence

All tests use the task worktree, temporary HOME/config, environment allowlist,
random loopback ports and deterministic local providers. Do not use the live
WebUI on port 9100, browser space 7, real credentials or the real Craft checkout.
The isolated pinned Craft mirror is the source-audit reference.

The final validation report must separate unit/contract coverage, real Harness
behavior, packaged subprocess behavior and platform checks. It must list every
inventory row that remains incomplete. Historical green runs are not evidence
for this branch.
