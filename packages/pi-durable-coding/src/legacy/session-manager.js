// Shared native session storage and migrations; retain the durable context policy.
export * from "@earendil-works/pi-coding-agent";
import * as shared from "@earendil-works/pi-coding-agent";

// Legacy JavaScript consumers accept host entries and structural plugin objects.
/** @type {any} */
const native = shared;
import { APP_NAME, getAgentDir, getSessionsDir } from "../upstream/config.ts";
import { buildDurableContextEntries, finalizeDurableProjection } from "../durable-projection.ts";

// Host-owned entries intentionally cross the existing untyped JavaScript boundary.
/** @type {import("./api-types.ts").LegacyConstructor<import("@earendil-works/pi-coding-agent").SessionManager>} */
const NativeSessionManager = shared.SessionManager;

/** @returns {any[]} */
export function sessionEntryToContextMessages(entry) {
    return native.sessionEntryToContextMessages(entry);
}

function selectContextEntries(path) {
    return path.some(entry => "durableEntryOrder" in entry) ? buildDurableContextEntries(path) : undefined;
}

/** @returns {any[]} */
export function buildContextEntries(entries, leafId, byId) {
    return native.buildContextEntries(entries, leafId, byId, selectContextEntries);
}

/** @returns {any[]} */
export function projectContextEntry(entry, edit) {
    const newerEdit = edit && (!("durableEntryOrder" in edit) || Number(edit.durableEntryOrder) > Number(entry.durableModelOrder));
    const messages = newerEdit && "durableBaseMessages" in entry ? entry.durableBaseMessages : "durableModelMessages" in entry ? entry.durableModelMessages : native.sessionEntryToContextMessages(entry);
    // Persisted edits are already folded into the durable contribution. Preview edits still use Pi semantics.
    if (edit && "durableModelOrder" in entry && "durableEntryOrder" in edit && Number(edit.durableEntryOrder) <= Number(entry.durableModelOrder))
        return messages;
    return native.projectContextEntry(entry, edit, messages);
}

const projectionOptions = { selectContextEntries, projectContextEntry, finalizeProjection: finalizeDurableProjection };

/** @returns {{entries: any[], messages: any[], thinkingLevel: string, model: any}} */
export function buildSessionProjection(entries, leafId, byId) {
    return native.buildSessionProjection(entries, leafId, byId, projectionOptions);
}

export function buildSessionContext(entries, leafId, byId) {
    const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId, byId);
    return { messages, thinkingLevel, model };
}

/** @returns {string} */
export function getDefaultSessionDir(cwd, agentDir = getAgentDir()) {
    return native.getDefaultSessionDir(cwd, agentDir);
}

export class SessionManager extends NativeSessionManager {
    constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedFileEntries) {
        super(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedFileEntries);
    }

    // Forward factories with the legacy class as the fallback receiver, including detached calls.
    /** @returns {SessionManager} */
    static create(cwd, sessionDir, options) {
        return Reflect.get(native.SessionManager, "create").call(this ?? SessionManager, cwd, sessionDir, options);
    }

    /** @returns {SessionManager} */
    static open(path, sessionDir, cwdOverride) {
        return Reflect.get(native.SessionManager, "open").call(this ?? SessionManager, path, sessionDir, cwdOverride);
    }

    /** @returns {SessionManager} */
    static continueRecent(cwd, sessionDir) {
        return Reflect.get(native.SessionManager, "continueRecent").call(this ?? SessionManager, cwd, sessionDir);
    }

    /** @returns {SessionManager} */
    static inMemory(cwd, options, entries) {
        return Reflect.get(native.SessionManager, "inMemory").call(this ?? SessionManager, cwd, options, entries);
    }

    /** @returns {SessionManager} */
    static forkFrom(sourcePath, targetCwd, sessionDir, options) {
        return Reflect.get(native.SessionManager, "forkFrom").call(this ?? SessionManager, sourcePath, targetCwd, sessionDir, options);
    }

    /** @returns {string | undefined} */
    static findById(cwd, id, sessionDir) {
        return Reflect.get(native.SessionManager, "findById").call(this ?? SessionManager, cwd, id, sessionDir);
    }

    /** @returns {Promise<any[]>} */
    static async list(cwd, sessionDir, onProgress, signal) {
        return Reflect.get(native.SessionManager, "list").call(this ?? SessionManager, cwd, sessionDir, onProgress, signal);
    }

    /** @returns {Promise<any[]>} */
    static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal) {
        return Reflect.get(native.SessionManager, "listAll").call(this ?? SessionManager, sessionDirOrOnProgress, onProgressOrSignal, signal);
    }

    static getDefaultAgentDir() {
        return getAgentDir();
    }

    static getSessionsDir() {
        return getSessionsDir();
    }

    getAppName() {
        return APP_NAME;
    }

    /** @returns {boolean} */
    usesDefaultSessionDir() {
        // The legacy host has no implicit agent directory.
        return getAgentDir();
    }

    buildContextEntries() {
        return buildContextEntries(this.getEntries(), this.getLeafId());
    }

    buildSessionProjection() {
        return buildSessionProjection(this.getEntries(), this.getLeafId());
    }

    buildSessionContext() {
        const { messages, thinkingLevel, model } = this.buildSessionProjection();
        return { messages, thinkingLevel, model };
    }
}
