// Only this isolated worker loads the separate pinned Pi reference installation.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readRequest, runScenario } from "./scenario-worker.mjs";
import { runPluginScenario } from "./plugin-worker.mjs";
const request = await readRequest();
const reference = (name, file) => import(pathToFileURL(join(request.referenceNodeModules, "@earendil-works", name, "dist", file)).href);
const [coding, core, ai, auth, loader, stores, schema] = await Promise.all([
  reference("pi-coding-agent", "index.js"), reference("pi-agent-core", "index.js"),
  reference("pi-ai", "compat.js"), reference("pi-coding-agent", "core/auth-storage.js"),
  reference("pi-coding-agent", "core/extensions/loader.js"),
  reference("pi-coding-agent", "core/models-store.js"), reference("pi-schema", "index.js"),
]);
const run = request.scenario.id === "native-plugin-contract" ? runPluginScenario : runScenario;
process.stdout.write(JSON.stringify(await run(request, { coding, core, ai, auth, loader, stores, schema })));
