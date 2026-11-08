# Pi-durable coding agent capabilities and Pi extension compatibility

## Baseline and goal

The runtime is named `pi-durable coding agent`, also called `durable coding
agent`. It combines pi-durable execution with the coding capabilities and
plugin ecosystem of Pi coding agent. All existing MkAgent product features
must remain complete and work through Desktop, WebUI, CLI and headless entry
points. The product preservation baseline for this correction is MkAgent
`cb0311f`, including the confirmed product behavior added after the first
integration. Keep subsequent confirmed product changes as implementation proceeds.
MkAgent `85325251a10d`, whose tree matches `0959d3563892`, is the historical
first-durable-integration comparison used by the inventory's Baseline column.
It does not limit the current feature set or authorize reverting later fixes.
The source baseline is Pi v1.5.0, commit
`f9a26365568127461c47a07a37dcb42c140a3ac5`. The coding package's Pi dependencies
are pinned to 1.5.0. The existing shared transport retains pi-ai 1.1.0.
The upstream `main` sources are review inputs:

- https://github.com/earendil-works/pi/tree/main/packages/durable
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent
- https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent

MkAgent first used Pi coding agent as its agent runtime. The first migration
replaced that runtime with pi-durable. Pi-durable already provides execution,
tools, storage, recovery and other capabilities. This work adds the missing
Coding capabilities and Pi plugin support to that existing runtime.

The clarification on 2026-11-08 requires correction of the migration design,
documents, code and tests. First correct the related documents, then implement
the corrections in order. Use pi-durable built-ins first, then public APIs in
independent official Pi SDK packages. Add compatibility code only when those
APIs cannot meet a confirmed requirement. Third-party library replacement is
separate work and does not establish compliance with the Pi SDK priority.

`pi-agent-core` is permitted where needed. Production must not depend on the
complete `pi-coding-agent` package or load that runtime through a subpath.
These rules replace the earlier dependency restriction in the first-switch
specifications.

Acceptance requires complete Coding capabilities, working Pi plugin contracts,
and preservation of existing MkAgent product features. Check the implementation
and behavior evidence for each capability. Current source layout, internal
state machines and old test expectations do not define new requirements.
Loading a plugin alone does not establish compatibility.

This specification defines the capability requirements. The
[implementation plan](durable-coding-agent-plan.md) defines the order of work.
The [architecture record](coding-architecture.md) describes the current code;
the [validation record](coding-validation.md) preserves checks at their stated
versions. Historical implementation choices do not override these requirements.
The inventory's baseline column describes the first durable integration before
the Coding additions, not the full feature set of the original Pi coding agent.

## Architecture

The target assembly is MkAgent product features above pi-durable, with Coding
and plugin compatibility added at the required interfaces. Pi-durable owns
execution scheduling, tool execution, task ownership, accepted inputs, storage,
transactions, cancellation and recovery. Use its existing implementations and
extension points before adding local implementations of those responsibilities.
MkAgent owns product sessions, permissions, credentials, transports and UI.

The Coding module supplies capabilities that remain missing after official SDK
reuse. It stays independent of MkAgent shared code, Electron and product UI.
The host supplies the required callbacks. Choosing AgentSession, a native
projection or a specific task layout is an implementation decision that must
follow the required behavior.

The current implementation uses `DurableKernel`, a ported `AgentSession`,
`DurableLoopBinding` and the `pi.coding.*` tasks. These tasks use the official
scheduler, but they also contain local request and tool state machines. Using
one Harness establishes scheduler ownership; it does not prove that execution
logic has been reused sufficiently. Review these state machines against
published `GenerationTask`, `ToolTask` and hooks before smaller helper changes.
Any replacement must preserve accepted work and supported stored task versions.

Normal and coding profiles retain their existing prompts, tool visibility,
permissions and resource policies. Runtime selection and Pi resource loading
are separate concerns. A shared runtime must not make normal sessions load
ambient Pi settings, extensions, skills or system-prompt files. Distinct durable
task types are allowed when they serve different operations; acceptance checks
execution ownership, capabilities and product behavior.

The current journal uses `SessionManager.inMemory()` for plugin reads and
previews. Durable transactions commit messages, custom entries, labels, context
edits, compaction and the active branch. Stable JSONL projections and a manifest
serve native path and import/export APIs; their writer does not own execution.
A revised implementation must preserve these observable APIs and existing data.
It may change the internal journal or projection arrangement when required
behavior and recovery remain intact.

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

Use this order for each required capability:

1. Use the existing pi-durable implementation through its published API.
2. If a capability is missing, use a public API from an independent official Pi
   SDK package, such as pi-ai, pi-agent-core, pi-tui, pi-mcp or pi-codemode.
3. If the public API needs protocol conversion or host policy, add the smallest
   external adapter. Keep execution and lifecycle work in the SDK.
4. Port or patch source only for a confirmed gap that the previous steps cannot
   meet. Record the required behavior, candidate API, observed gap, affected
   callers, recovery impact and upgrade work.

Different signatures, a failed direct forwarding attempt or an old test failure
are reasons to investigate. They do not establish that a whole implementation
must be retained. Check whether the difference is a product or public plugin
contract before adding compatibility behavior. Reflection layout, private
callback counts and getter order need a confirmed caller or contract to become
acceptance requirements. Preserve permission, cancellation, error, data and
recovery guarantees during this assessment.

A package import that requires a repository patch is a local SDK modification.
Label its added exports and behavior as such. Do not present those interfaces as
APIs already published by Pi. Assess the patch and adapter together, including
upgrade and migration cost; moving local code into an SDK patch is not sufficient
reuse. The current core operation and Agent injection APIs, and parts of the
durable integration, require the patches registered in the root manifest.

Production already uses durable `/tools`, `/images`, `/codemode` and
`/tool-search`. Retain that reuse. Local grep/find/ls require their own gap and
behavior checks because durable 1.5.0 does not publish those tool factories.
Standalone Native tool factories exposed to plugins must be assessed separately
from the production tool installation.

The current generator starts from the full Pi coding public entry. Its closure
includes CLI and run modes. That is a source inventory, not an acceptance target
or proof of necessity. Derive the required export surface from Coding behavior,
public plugin APIs and MkAgent entry points. Assess upstream CLI/run-mode code
separately from reusable plugin UI components. Neither wholesale retention nor
removal follows from the current export list alone.

`UPSTREAM-RUNTIME.json` and `UPSTREAM.json` record source provenance and
transformations. Their checks establish reproducibility at the stated versions,
not the necessity of each file. A compatibility export list describes implemented
exports and requires corresponding behavior evidence. Resolve plugin imports
of the coding SDK name to the supported local interface or independent official
Pi packages without loading the prohibited complete package.

## Durable boundary requirement

Native `turn_end` and `agent_before_settle` handlers can refer to a committed
message entry, return context edits and custom entries, and request continuation.
Durable 1.5.0's `onYield` runs before final answer persistence; `afterRun` runs
after input settlement. Neither hook alone preserves this protocol.

The current coding runtime uses versioned local durable tasks and commits
native drafts, accepted input identities and the next checkpoint together.
It records request intent before uncertain callbacks and does not automatically
repeat unsafe tools or uncertain plugin effects. Preserve these safety and data
guarantees while evaluating official execution and transaction APIs. A different
internal phase layout is permitted.

The installed SDK includes repository-added `codingPrepare`, `codingStream` and
`codingBoundary` hooks. They are not evidence of an unmodified published API.
Published Pi 1.5.0 defines `pi.generation` v2 and `pi.tool` v3; the repository
patch raises generation to v4. It also raises `CODEMODE_MODULE_VERSION` from 2
to 3. That is a replay-module version, not a task or document-schema version.
Removing a patch requires explicit handling of its stored states and logs;
reinstalling the same package version does not provide that conversion.
Their current behavior and the local task bridges require comparison against
required Coding contracts. A hook gap can justify a narrow adapter or extension;
it does not by itself justify retaining the full local execution loop.

Keep supported stored tasks readable during any transition. The existing
`pi.coding.{session,run,call,tool,summary}` kinds are v1. A new implementation
must handle their input, checkpoints and results explicitly; official task
migrations do not convert them automatically. Summary tasks serve compaction,
branch summaries and bug reports. Preserve completed responses and report
uncertain requests without automatically sending them again. The legacy durable
patch remains in use by the older SDK path and migration. External plugin
effects have no exactly-once guarantee.

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
| Prompt templates | Absent | Pi resource parsing, quoting, defaults, slices, collision and unknown commands |
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

Follow the [correction list](coding-follow-up.md) in this order:

1. Correct related requirements, architecture, plans, acceptance and historical
   document notices against the 2026-11-08 clarification.
2. Map production behavior and public plugin contracts to published Pi SDK
   capabilities. Check execution, tools, hooks, storage and recovery first.
3. Implement confirmed SDK replacements and the required compatibility and
   stored-data transitions. Then reduce the remaining Coding source scope.
4. Correct tests that enforce unsupported implementation choices. Retain and
   extend behavior checks for required product, plugin and recovery contracts.
5. Verify actual file, shell and plugin workflows through deterministic local
   providers, then run affected product, package and repository checks.
6. Update acceptance and provenance records with the actual results and open
   gaps. Stop at the defined delivery conditions.

The earlier closure-first implementation and checks at `4776fe1` remain
historical evidence. They do not establish completion of this correction.
The full upstream CLI, a fixed source count and a particular task arrangement
are not independent deliverables. Product and plugin capabilities remain in
scope. Publications, remote writes, paid model requests and real account use
require their own authorization; a design document does not grant it.

## Upgrade, performance and rollback

Pin the interacting Coding SDK dependencies to tested versions. The current
Coding packages use Pi 1.5.0 while shared transport still declares pi-ai 1.1.0;
this work does not imply a repository-wide version update. On upgrade compare
published exports, extension actions/events, tools, resources, package resolution,
assets and runtime effects. Review local SDK patches separately. Test unchanged
plugin fixtures and report unsupported operations explicitly.

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

Tests must check required behavior through public interfaces where possible.
Keep permission denial, cancellation, error propagation, tool results, plugin
lifecycle, accepted input identity and crash recovery checks. A source hash,
private phase name, prototype layout or exact helper call trace can diagnose a
change but does not establish a user requirement. Replace such assertions when
the public behavior remains correct; do not delete a behavior check merely to
make an SDK replacement pass. Documentation-only corrections require link,
consistency, punctuation and independent document checks, not a product rerun.
