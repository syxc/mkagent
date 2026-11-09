// This worker uses the production durable Agent and the complete local native coding source.
import * as coding from "../../src/pi/index.ts";
import * as core from "../../src/agent-runtime.ts";
import * as ai from "@earendil-works/pi-ai/compat";
import * as auth from "../../src/pi/core/auth-storage.ts";
import * as loader from "../../src/native-extension-loader.ts";
import * as stores from "../../src/pi/core/models-store.ts";
import * as schema from "@earendil-works/pi-schema";
import { readRequest, runScenario } from "./scenario-worker.mjs";
import { NativeSessionJournal } from "../../src/durable-coding/session-journal.ts";
import { DurableLoopBinding } from "../../src/durable-coding/engine.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

async function persistence(cwd) {
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), {
    registry, models: builtinModels({ credentials: new InMemoryCredentialStore() }),
  }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const journal = await NativeSessionJournal.open({ harness, conversation, cwd, context: BACKGROUND_CONTEXT });
  const binding = new DurableLoopBinding({ kernel: { harness, conversation, registry }, journal });
  return {
    manager: journal.manager, binding, flush: () => journal.flush(),
    close: async () => { journal.close(); await harness.close(BACKGROUND_CONTEXT); },
  };
}

const request = await readRequest();
process.stdout.write(JSON.stringify(await runScenario(request, { coding, core, ai, auth, loader, stores, schema, persistence })));
