// =========================
// SKILL COMPILER - from the trace of a successful run to an executable script
// =========================
// The compiler never asks a model to write code: it deterministically generates a script
// that replays the same tools, in the same order, with parameterized arguments. Every
// argument value must be justifiable:
//   - it comes from a request parameter        → {{param}} placeholder
//   - it comes from an earlier step's result   → { "$from": ... } reference
//   - it is a constant of the procedure (e.g. "sobject-name": "Task") → stays literal
// A value that fits none of these and looks like an opaque identifier makes compilation
// fail: a skill that always writes to the same record is not a procedure.
import { parseToolContent } from "./runtime.mjs";
import { successfulSteps } from "./procedure-recorder.mjs";
import { resolveIdentifiers } from "./identifiers.mjs";

// Import used by generated scripts to reach the runtime helpers: a bare specifier,
// resolved from the host project's node_modules rather than a brittle relative path.
export const DEFAULT_RUNTIME_IMPORT = "@script-flow/procedural-memory/runtime";

const VALID_INTENT = /^[a-z][a-z0-9_]*$/;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every path, inside a step's (normalized) result, holding `target`.
 * @returns {string[]} dotted paths ("records.0.Id")
 */
export function findValuePaths(value, target, prefix = "") {
    if (value == null) return [];
    if (typeof value !== "object") {
        return String(value) === String(target) ? [prefix] : [];
    }
    return Object.entries(value).flatMap(([key, child]) =>
        findValuePaths(child, target, prefix ? `${prefix}.${key}` : key)
    );
}

/**
 * First path of a scalar value inside a step's result.
 * @returns {string|null}
 */
export function findValuePath(value, target, prefix = "") {
    return findValuePaths(value, target, prefix)[0] ?? null;
}

function locateInPreviousSteps(value, previousResults) {
    for (let step = previousResults.length - 1; step >= 0; step--) {
        const found = findValuePath(previousResults[step], value);
        if (found !== null) return { step, path: found };
    }
    return null;
}

// Small integers (limit, page, retry count) stay constant: they collide too easily with
// some count inside an earlier result.
const SMALL_INTEGER = 10;

/**
 * A number may come from an earlier step (coordinates, amounts, numeric ids). Two
 * safeguards: the value must appear exactly **once** in the chosen result, and small
 * integers stay constant. Booleans are never linked: they are flags of the procedure.
 */
function referenceToNumericValue(value, previousResults) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (Number.isInteger(value) && Math.abs(value) <= SMALL_INTEGER) return null;

    for (let step = previousResults.length - 1; step >= 0; step--) {
        const paths = findValuePaths(previousResults[step], value);
        if (paths.length === 1) return { $from: { step, path: paths[0] } };
    }
    return null;
}

function referenceToPreviousStep(value, previousResults) {
    const located = locateInPreviousSteps(value, previousResults);
    return located ? { $from: located } : null;
}

/**
 * Identifiers left literal inside a larger string (typically `WHERE Id = '001...'` in a
 * query) become references to the step that produced them. An identifier that comes from
 * nowhere is a problem: baked into the script, the skill would always hit the same record.
 */
function replaceEmbeddedIds(text, { previousResults, problems, keyPath, identifiers }) {
    return identifiers.replace(text, (id) => {
        const located = locateInPreviousSteps(id, previousResults);
        if (located) return `{{@${located.step}.${located.path}}}`;
        problems.push(`argument ${keyPath} contains the identifier ${id}, which comes neither from a parameter nor from an earlier step`);
        return id;
    });
}

/**
 * Replaces occurrences of the parameter values in the text with their placeholders.
 * @returns {{ text: string, used: string[] }}
 */
function applyParameters(text, parameterEntries) {
    let result = text;
    const used = [];
    for (const [name, rawValue] of parameterEntries) {
        const value = String(rawValue);
        if (!value || !new RegExp(escapeRegExp(value), "i").test(result)) continue;
        result = result.replace(new RegExp(escapeRegExp(value), "gi"), `{{${name}}}`);
        used.push(name);
    }
    return { text: result, used };
}

function compileValue(value, { parameterEntries, previousResults, usedParams, problems, keyPath, identifiers }) {
    if (Array.isArray(value)) {
        return value.map((item, i) => compileValue(item, { parameterEntries, previousResults, usedParams, problems, keyPath: `${keyPath}[${i}]`, identifiers }));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [
            key,
            compileValue(child, { parameterEntries, previousResults, usedParams, problems, keyPath: keyPath ? `${keyPath}.${key}` : key, identifiers })
        ]));
    }
    if (typeof value !== "string") {
        // A number can be a request parameter, or a value read from an earlier step
        const fromParameter = parameterEntries.find(([, parameterValue]) => String(parameterValue) === String(value));
        if (fromParameter) {
            usedParams.add(fromParameter[0]);
            return `{{${fromParameter[0]}}}`; // placeholder on its own: renderArgs preserves the type
        }
        return referenceToNumericValue(value, previousResults) ?? value;
    }

    const { text, used } = applyParameters(value, parameterEntries);
    used.forEach(name => usedParams.add(name));

    if (!used.length) {
        // Whole value taken from an earlier step (an id just read, a name, a field)
        const reference = referenceToPreviousStep(text, previousResults);
        if (reference) return reference;
    }
    // What is left are identifiers nested in larger strings: queries are the typical case
    return replaceEmbeddedIds(text, { previousResults, problems, keyPath, identifiers });
}

function renderSource({ intent, parameterNames, tools, steps, userMessage, runtimeImport, createdAt }) {
    return `// Skill compiled automatically by @script-flow/procedural-memory: do not edit by hand.
// intent: ${intent}
// created: ${createdAt}
// learned from: ${JSON.stringify(userMessage)}
import { renderArgs, parseToolContent } from ${JSON.stringify(runtimeImport)};

export const intent = ${JSON.stringify(intent)};
export const parameters = ${JSON.stringify(parameterNames)};
export const tools = ${JSON.stringify(tools)};

const STEPS = ${JSON.stringify(steps, null, 4)};

/**
 * Replays the recorded procedure.
 * @param {object} params values extracted from the request (keys: ${parameterNames.join(", ") || "none"})
 * @param {{ callTool: (tool: string, args: object) => Promise<{ok: boolean, content: Array}> }} context
 * @returns {Promise<{ ok: boolean, steps: Array, failedStep?: string }>}
 */
export async function run(params, { callTool }) {
    const executed = [];
    const results = [];
    for (const step of STEPS) {
        const args = renderArgs(step.args, params, results);
        const result = await callTool(step.tool, args);
        results.push(parseToolContent(result.content));
        executed.push({ tool: step.tool, args, ok: result.ok, content: result.content });
        if (!result.ok) return { ok: false, failedStep: step.tool, steps: executed };
    }
    return { ok: true, steps: executed };
}
`;
}

/**
 * Compiles an execution trace into a skill script.
 * @param {{ intent: string, parameters?: object, trace: { userMessage: string, steps: Array },
 *           runtimeImport?: string, identifiers?: { find: Function, replace: Function }, now?: () => Date }} input
 * @returns {{ ok: true, source: string, definition: object } | { ok: false, reason: string }}
 */
export function compileProcedure({ intent, parameters = {}, trace, runtimeImport = DEFAULT_RUNTIME_IMPORT, identifiers, now = () => new Date() }) {
    const rules = resolveIdentifiers(identifiers);
    if (!VALID_INTENT.test(String(intent ?? ""))) {
        return { ok: false, reason: `invalid intent: ${intent}` };
    }
    // Successful steps only: a failed attempt changed nothing and must not be replayed.
    // Filtering before the loop keeps the { $from: { step } } indexes consistent.
    const traceSteps = successfulSteps(trace);
    if (!traceSteps.length) return { ok: false, reason: "empty trace: no successful step to compile" };

    const userMessage = trace.userMessage ?? "";
    const parameterEntries = Object.entries(parameters).filter(([, value]) => value !== null && value !== undefined && value !== "");
    const usedParams = new Set();
    const problems = [];
    const previousResults = [];
    const steps = [];

    for (const step of traceSteps) {
        const args = compileValue(step.args ?? {}, {
            parameterEntries, previousResults, usedParams, problems, keyPath: "", identifiers: rules
        });
        steps.push({ tool: step.tool, args });
        previousResults.push(parseToolContent(step.content));
    }

    const unusedParams = parameterEntries.map(([name]) => name).filter(name => !usedParams.has(name));
    if (unusedParams.length) {
        problems.push(`parameters ${unusedParams.join(", ")} appear in no argument: the procedure would not depend on the request`);
    }
    if (problems.length) return { ok: false, reason: problems.join("; ") };

    const parameterNames = parameterEntries.map(([name]) => name);
    const tools = [...new Set(steps.map(step => step.tool))];
    const createdAt = now().toISOString();

    return {
        ok: true,
        source: renderSource({ intent, parameterNames, tools, steps, userMessage, runtimeImport, createdAt }),
        definition: {
            intent,
            description: `Learned from: ${userMessage}`,
            parameters: parameterNames,
            tools,
            script: `${intent}.mjs`,
            createdAt
        }
    };
}
