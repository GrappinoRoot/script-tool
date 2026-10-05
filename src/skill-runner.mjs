// =========================
// SKILL RUNNER - executing a compiled skill
// =========================
// Loads the skill's script and runs it with the callTool provided by the host: a skill
// skips the reasoning, not your checks. Every tool call still goes through your callTool,
// so whatever guards you have around tools (permissions, confirmations, auditing) still
// apply. Any failure becomes an { ok: false } result, so the caller can fall back to its
// normal agent path.
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

/**
 * Runs a registered skill.
 * @param {{ intent: string, script: string, parameters?: string[] }} definition
 * @param {object} params values extracted from the request
 * @param {{ callTool: Function, root?: string }} context
 * @returns {Promise<{ ok: boolean, steps?: Array, error?: string }>}
 */
export async function runSkill(definition, params = {}, { callTool, root } = {}) {
    if (typeof callTool !== "function") return { ok: false, error: "missing callTool" };
    if (!root) return { ok: false, error: "missing root (the skills directory)" };

    const scriptPath = path.isAbsolute(definition?.script ?? "")
        ? definition.script
        : path.join(root, definition?.script ?? "");

    let stats;
    try {
        stats = fs.statSync(scriptPath);
    } catch {
        return { ok: false, error: `script not found: ${scriptPath}` };
    }

    const missing = (definition.parameters ?? []).filter(name => params?.[name] === undefined);
    if (missing.length) return { ok: false, error: `missing parameters: ${missing.join(", ")}` };

    try {
        // mtime in the query string: a rewritten script is not served from the module cache
        const module = await import(`${pathToFileURL(scriptPath).href}?v=${stats.mtimeMs}`);
        if (typeof module.run !== "function") return { ok: false, error: `${definition.script} does not export run()` };

        const result = await module.run(params, { callTool });
        return { ...result, ok: result?.ok !== false };
    } catch (e) {
        return { ok: false, error: `skill execution failed: ${e.message}` };
    }
}
