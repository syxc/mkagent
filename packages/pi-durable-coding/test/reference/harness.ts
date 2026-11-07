// Launch behavior workers with synthetic HOME/config and an explicit reference installation.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PINNED_PI_COMMIT, PINNED_PI_VERSION, PROTOCOL_VERSION,
  type OracleRequest, type OracleResponse, type OracleScenario, type OracleTrace,
  type ReferenceProvenance, type ScenarioRunner,
} from "./protocol.ts";

export interface ReferenceOptions {
  /** The separate probe installation, never the production node_modules. */
  referenceNodeModules: string;
  upstreamRoot: string;
  executable?: string;
  timeoutMs?: number;
}

export interface WorkerLaunch {
  script: string;
  /** A Bun executable; it must support --no-env-file and --no-install. */
  executable?: string;
  timeoutMs?: number;
}

export interface ReferenceRunner {
  (scenario: OracleScenario): Promise<OracleTrace>;
  readonly provenance: ReferenceProvenance;
}

/** Validate the supplied source pin and fingerprint the installed reference inputs once. */
export async function createReferenceRunner(options: ReferenceOptions): Promise<ReferenceRunner> {
  if (!isAbsolute(options.referenceNodeModules) || !isAbsolute(options.upstreamRoot)) {
    throw new Error("Reference installation and upstream checkout paths must be absolute");
  }
  const env = safeEnvironment();
  const head = spawnSync("git", ["-C", options.upstreamRoot, "rev-parse", "HEAD"], { env, encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim() !== PINNED_PI_COMMIT) {
    throw new Error(`Reference checkout must be ${PINNED_PI_COMMIT}: ${head.stderr || head.stdout}`);
  }
  const status = spawnSync("git", ["-C", options.upstreamRoot, "status", "--porcelain", "--untracked-files=no"], {
    env, encoding: "utf8",
  });
  if (status.status !== 0 || status.stdout.trim()) throw new Error("Pinned upstream checkout has tracked modifications");
  const installedFilesSha256: Record<string, string> = {};
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai"]) {
    const relative = `@earendil-works/${name}/package.json`;
    const data = readFileSync(join(options.referenceNodeModules, relative));
    const manifest = JSON.parse(data.toString());
    if (manifest.name !== `@earendil-works/${name}` || manifest.version !== PINNED_PI_VERSION) {
      throw new Error(`Reference ${name} must be version ${PINNED_PI_VERSION}`);
    }
    installedFilesSha256[relative] = createHash("sha256").update(data).digest("hex");
  }
  for (const relative of [
    "pi-agent-core/dist/agent.js", "pi-agent-core/dist/agent-loop.js",
    "pi-coding-agent/dist/core/agent-session.js", "pi-coding-agent/dist/core/session-manager.js",
    "pi-coding-agent/dist/core/extensions/runner.js", "pi-ai/dist/providers/faux.js",
  ]) {
    const path = `@earendil-works/${relative}`;
    installedFilesSha256[path] = createHash("sha256").update(readFileSync(join(options.referenceNodeModules, path))).digest("hex");
  }
  const provenance: ReferenceProvenance = {
    version: PINNED_PI_VERSION, sourceCommit: PINNED_PI_COMMIT, installedFilesSha256,
  };
  const run = async (scenario: OracleScenario): Promise<OracleTrace> => {
    const request: OracleRequest = {
      version: PROTOCOL_VERSION, scenario, referenceNodeModules: resolve(options.referenceNodeModules), provenance,
    };
    const response = await runIsolatedWorker(request, {
      script: fileURLToPath(new URL("./native-worker.mjs", import.meta.url)),
      executable: options.executable, timeoutMs: options.timeoutMs,
    });
    if (JSON.stringify(response.provenance) !== JSON.stringify(provenance)) {
      throw new Error("Reference worker returned different provenance");
    }
    return response.trace;
  };
  return Object.assign(run, { provenance });
}

/** Run a native or durable JSON worker without inherited credentials, proxies, or config. */
export async function runIsolatedWorker(request: OracleRequest, launch: WorkerLaunch): Promise<OracleResponse> {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-behavior-oracle-"));
  const dirs = Object.fromEntries(["home", "config", "cache", "cwd", "tmp"].map((key) => [key, join(sandbox, key)]));
  for (const path of Object.values(dirs)) mkdirSync(path);
  const env = {
    ...safeEnvironment(),
    HOME: dirs.home, CONFIG_DIR: dirs.config, XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp, PI_CODING_AGENT_DIR: dirs.config,
    BUN_INSTALL_CACHE_DIR: dirs.cache, npm_config_cache: dirs.cache,
    MKAGENT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1",
    PI_ORACLE_WORKER: "1", CI: "1", NO_COLOR: "1",
  };
  try {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(launch.executable ?? process.execPath, [
        "--no-env-file", "--no-install", resolve(launch.script),
      ], { cwd: dirs.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let tooLarge = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, launch.timeoutMs ?? 15_000);
      const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (stream === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
        if (stdout.length + stderr.length > 16 * 1024 * 1024) {
          tooLarge = true;
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdin.on("error", () => {});
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut || tooLarge || code !== 0) {
          reject(new Error(`Oracle ${request.scenario.id}: ${timedOut ? "timeout" : tooLarge ? "output limit" : `exit ${code}/${signal}`}\n${stderr}`));
        } else resolveOutput(stdout);
      });
      child.stdin.end(JSON.stringify(request));
    });
    const value: unknown = JSON.parse(output);
    assertResponse(value, request.scenario);
    return value;
  } finally {
    // Only the unique directory created by this invocation is removed.
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function assertResponse(value: unknown, scenario: OracleScenario): asserts value is OracleResponse {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== PROTOCOL_VERSION ||
      !("trace" in value) || !value.trace || typeof value.trace !== "object" ||
      !("provenance" in value) || !("scenarioId" in value.trace) || value.trace.scenarioId !== scenario.id ||
      !("timeline" in value.trace) || !Array.isArray(value.trace.timeline) ||
      !("final" in value.trace) || !("effects" in value.trace) || !Array.isArray(value.trace.effects)) {
    throw new Error(`Invalid oracle worker response for ${scenario.id}`);
  }
}

/** Convenient adapter for a durable worker implementing the same request/response contract. */
export function createWorkerRunner(launch: WorkerLaunch, reference: Pick<OracleRequest, "referenceNodeModules" | "provenance">): ScenarioRunner {
  return async (scenario): Promise<OracleTrace> => (await runIsolatedWorker({
    version: PROTOCOL_VERSION, scenario, ...reference,
  }, launch)).trace;
}
