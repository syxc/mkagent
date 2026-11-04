# Durable coding validation and limits

## Implemented scope

The coding profile uses the existing `DurableKernel`. The independent
`@mkagent/pi-durable-coding` package supplies native resources and a source-ported
Pi extension runner. Pi v1.5.0, commit
`f9a26365568127461c47a07a37dcb42c140a3ac5`, is the source baseline.
`UPSTREAM.json` records 36 source files and fixtures. The package includes the
upstream MIT license.

The durable patch adds awaited preparation and stream hooks, plus committed
`turn_end` and `agent_before_settle` decisions. Draft entries and the next task
checkpoint commit together. Tests cover interruption inside preparation, restart
after preparation commits, and migration of stored v1, v2 and v3 preparation
checkpoints to v4. Effects outside durable storage can repeat if a handler is
interrupted before its decision is memoized.

The host permission wrapper still owns tool approval. Native `tool_call` handlers
run before approval. `tool_result` observes the final approved arguments.
Synchronous plugin metadata uses the native session view and persists in durable
history. The separate native JSONL writer does not own production storage.

The shared host event types retain the existing wire contract locally. The
production dependency graph must contain neither `pi-coding-agent` nor
`pi-agent-core`. Plugin import aliases expose the implemented local export set;
attempts to run the legacy Agent or import its private subpaths fail explicitly.

## Verification

All checks use temporary configuration, an environment allowlist, local
deterministic models and random loopback ports. They do not use the live WebUI,
real credentials or the real Craft checkout.

| Check | Result |
| --- | --- |
| Coding package, production host and standalone bundle | 78 tests pass, 358 assertions |
| Durable kernel regression | 153 tests pass, 1,914 assertions |
| Host tool wrappers and image reads | 8 tests pass, 36 assertions |
| Coding and agent-server type checks | Pass |
| Repository `validate:ci` | Pass, including the coding package type check |
| Repository lint | Pass with warnings |
| Pinned Pi source reproduction | 36 files verified |
| Durable patch reproduction | Pass with semantic TypeScript validation |
| Frozen install in a clean directory | Pass; installed patch matches generated output |
| Agent-server build | Pass |
| Craft source-lineage audit | Pass against the isolated pinned mirror |
| Shared event contract after legacy dependency removal | Pass |
| OpenAI, relay and Responses stream regression | 27 tests pass, 128 assertions |
| Full headless CLI | Pass with the unchanged hello plugin and two local model requests |

The standalone bundle test builds the real subprocess outside the source tree.
It loads an unchanged official `hello` extension, receives a host approval
modification, executes the tool and sends the approved result in the next
request. It exercises the packaged module resolver through real JSONL I/O.

The full headless CLI check also starts the real server, creates an isolated
workspace and connection, enables coding mode, executes `hello` and receives the
final answer. Its combined tool-call and finish frame exposed a host SSE defect.
The correction preserves terminal markers, text, usage and other choices while
forwarding each cleaned tool call once. Five added stream cases failed before
the correction; the unchanged CLI fixture then completed successfully.

The regression checks also cover context replacements after committed edits,
error-boundary continuation, model selection after host collection replacement,
prompt composition with `SYSTEM.md`, and retention of distinct instruction-file
sources. Each of these cases failed before its correction.

## Capability boundaries

The table follows the acceptance inventory. A retained feature or a passing
fixture does not establish every upstream combination.

| Inventory area | Verified behavior and remaining limits |
| --- | --- |
| read/write/edit/bash | Existing durable tools remain. Approved file writes and Bash timeout pass. The complete exact-edit, shell-exit and cancellation matrix is not repeated here. |
| grep/find/ls | Existing local adaptations remain. A complete native schema, ignore-rule, Unicode and limit comparison is pending. |
| Images and long output | BMP conversion and large-image resizing pass. The complete output-spill and recovery matrix is pending. |
| PowerShell | A native named tool and Windows execution are not verified. |
| Permissions and metadata | Host approval modification, denial, final arguments and nested durable calls are covered. Trusted plugin code itself is not sandboxed. |
| Project instructions | Global, ancestor, cwd and worktree parsing pass. Native paths retain their source identity. Deduplication between host-rendered text and native files needs shared source metadata. |
| SYSTEM/APPEND files | Native precedence and composition are covered. The host base prompt remains present when `SYSTEM.md` supplies coding instructions. |
| Native skills | Native parsing, collisions, explicit invocation and installed resources are covered. |
| Skill activation | Native command expansion passes. Integration with every shared mention and successful-read prerequisite remains incomplete. |
| Prompt templates | Quoting, empty arguments, defaults, slices, unknown commands and input transforms pass. |
| Extensions: tools | The official hello plugin, structured results, nested calls, visibility, progress and cancellation have functional coverage. |
| Extensions: commands/input | Commands, transform/handled behavior, extension input source and template expansion are covered. Production reload combinations need further coverage. |
| Extensions: events | Session start, input, before-start, run/turn start, user/custom and assistant message preparation, assistant streaming, tool call/result and settlement boundaries are covered. Native `agent_end`, tool-result message lifecycle and tool-execution lifecycle ordering are incomplete. |
| Extensions: context | Before-start prompt changes, request transforms and committed edit preservation pass. Complex provenance combinations remain an acceptance area. |
| Extensions: state | Custom metadata, stable IDs, labels/name projection, restore and isolated store forks are covered. Managed-session lifecycle combinations need further coverage. |
| Extensions: models | Host authentication, provider registration, overrides, restoration and host collection replacement pass. Virtual model routing, immediate auth-snapshot refresh and interactive OAuth are incomplete. |
| Extensions: session control | Unsupported setup/withSession, tree navigation and managed switching fail explicitly. Basic new/fork adapters exist; complete owner, close and abort semantics are not verified. |
| Extensions: UI | The runtime reports print mode and no interactive UI. It does not provide the native TUI. |
| Local package resources | Installed manifest discovery, patterns, filters and source diagnostics are covered. |
| npm/git package management | Opening resources does not fetch missing packages. Explicit installation workflows are not fully exercised. |
| Project MCP | Project execution requires an explicit trusted host configuration. The normal product trust-approval UI is not integrated. |
| MCP OAuth | Interactive authorization remains unavailable. |
| Codemode/tool search | Existing official durable integrations remain. Nested plugin calls and hidden tools are covered. Complete dynamic removal and exposure combinations need further coverage. |
| Retry/steer/follow-up/compaction | Kernel regressions pass. Native boundary continuation and preparation recovery have additional real Harness tests. |
| Resume/branch/usage/export | Existing kernel regressions and native projection/store tests pass. Full native managed-session branching is not established. |
| CLI/JSONL/Desktop/WebUI | Source JSONL, the standalone subprocess and the full headless CLI pass. Desktop and browser interaction were not exercised. |
| Themes/shortcuts/editor/renderers | Resource diagnostics are retained. Terminal rendering, editor integration and shortcuts need a TUI host. |

The implementation therefore provides tested API groups, not complete Pi
ExtensionAPI or TypeScript SDK compatibility. The no-UI boundary and unimplemented
event groups must remain visible to plugin authors.

## Reproduction and upgrade

Run these checks in an isolated environment:

```sh
bun test ./packages/pi-durable-coding \
  ./packages/pi-agent-server/src/coding-host.e2e.test.ts \
  ./packages/pi-agent-server/test/coding-bundle.e2e.test.ts
bun test ./packages/pi-agent-server/src/kernel.e2e.test.ts
bun test ./packages/pi-agent-server/src/tools/wrap.test.ts \
  ./packages/pi-agent-server/src/tools/builtin.test.ts
bun run validate:ci
bun run lint
bun run audit:craft-reuse
bun run --cwd packages/pi-agent-server build
bun install --frozen-lockfile --ignore-scripts
```

The source audit requires `CRAFT_AGENT_SOURCE` to identify the isolated pinned
Craft reference. Source-port reproduction uses
`packages/pi-durable-coding/scripts/vendor-upstream.ts <Pi checkout> --check`.
Patch reproduction uses `scripts/patch-durable.ts` in that package with the
pinned checkout, installed durable directory and pristine durable directory.
Use `--check` to compare generated files without rewriting them.

On upgrade, compare upstream event and resource behavior, regenerate both
manifests and the Bun patch, then rerun the functional fixtures and stored-task
migrations. Tests for the current checkpoint versions do not establish migration
support for a future Pi release.
