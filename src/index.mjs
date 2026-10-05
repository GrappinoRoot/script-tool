// =========================
// PROCEDURAL MEMORY - public API
// =========================
// An agent that solves the same task twice pays for the reasoning twice. This library
// records the procedure of a successful task, compiles it into an executable script and
// replays it on the next matching request: the model is there to find a new solution, not
// to repeat one that was already verified.
//
// The library knows neither your tools nor your model: `chat` and `callTool` are yours and
// stay yours, so whatever you enforce around tools (permissions, confirmations, guards)
// still applies when the caller is a compiled skill.
import { extractIntent } from "./intent-extractor.mjs";
import { createRecorder, isSuccessfulRun } from "./procedure-recorder.mjs";
import { compileProcedure } from "./skill-compiler.mjs";
import { listSkills, findSkill, saveSkill, recordUsage } from "./skill-registry.mjs";
import { runSkill } from "./skill-runner.mjs";
import { resolveIdentifiers } from "./identifiers.mjs";

export { extractIntent, buildIntentPrompt, normalizeParameterValue } from "./intent-extractor.mjs";
export { createRecorder, isSuccessfulRun, successfulSteps } from "./procedure-recorder.mjs";
export { compileProcedure, findValuePath, findValuePaths, DEFAULT_RUNTIME_IMPORT } from "./skill-compiler.mjs";
export { loadRegistry, listSkills, findSkill, saveSkill, recordUsage, REGISTRY_FILE } from "./skill-registry.mjs";
export { runSkill } from "./skill-runner.mjs";
export { defaultIdentifiers, resolveIdentifiers } from "./identifiers.mjs";
export { renderArgs, parseToolContent, getAtPath, SkillParameterError } from "./runtime.mjs";

/**
 * Creates the procedural memory of an agent.
 *
 * @param {object} options
 * @param {string} options.root directory holding registry.json and the generated scripts
 * @param {(request: object) => Promise<{message?: {content?: string}}>} options.chat
 *   your model call, in the shape of ollama.chat / OpenAI chat completions
 * @param {string} [options.model] passed to `chat` only when set
 * @param {string} [options.domainHint] what the requests are about, for the extraction prompt
 * @param {Array<{request: string, intent: string, parameters: object}>} [options.examples]
 * @param {{ find?: Function, replace?: Function }} [options.identifiers]
 *   how to recognize an opaque identifier (default: neutral heuristic, see identifiers.mjs)
 * @param {string} [options.runtimeImport] helper import written into generated scripts
 * @param {{ warn?: Function }} [options.logger]
 * @returns {{ resolve: Function, run: Function, learn: Function, skills: Function }}
 */
export function createProceduralMemory({
    root,
    chat,
    model,
    domainHint,
    examples,
    identifiers,
    runtimeImport,
    logger = console
} = {}) {
    if (!root) throw new Error("createProceduralMemory: 'root' is required (the skills directory)");
    const rules = resolveIdentifiers(identifiers);

    // Named object rather than `this`: the methods keep working when destructured
    const memory = {
        /** Registered skills, without their code. */
        skills: () => listSkills(root),

        /**
         * Classifies the request and looks for a procedure already learned.
         * @param {string} userMessage
         * @returns {Promise<object>} task: { intent, parameters, skill, record*, recorder }
         */
        async resolve(userMessage) {
            const extracted = await extractIntent(userMessage, {
                chat, model, domainHint, examples, logger,
                identifiers: rules,
                knownSkills: listSkills(root)
            });
            const recorder = createRecorder(userMessage);

            return {
                userMessage,
                intent: extracted?.intent ?? null,
                parameters: extracted?.parameters ?? {},
                skill: extracted ? findSkill(extracted.intent, root) : null,
                // the caller records here what it executes on the agent path
                record: recorder.recordToolCall,
                recordSkipped: recorder.recordSkipped,
                recordFinalAnswer: recorder.recordFinalAnswer,
                recorder
            };
        },

        /**
         * Wraps your callTool so that every call it makes is recorded on this task.
         * Lets you keep your agent loop exactly as it is: nothing in it has to know about
         * this library, and no executed tool can be forgotten.
         * @param {object} task the object returned by resolve()
         * @param {(tool: string, args: object) => Promise<{ok: boolean, content: Array}>} callTool
         * @returns {(tool: string, args: object) => Promise<{ok: boolean, content: Array}>}
         */
        instrument(task, callTool) {
            return async (tool, args) => {
                let result;
                try {
                    result = await callTool(tool, args);
                } catch (e) {
                    // A tool that throws never ran to completion: record it as a failure and
                    // let the exception through, so the caller's error handling is unchanged.
                    task.record({ tool, args, ok: false, content: [{ type: "text", text: String(e?.message ?? e) }] });
                    throw e;
                }
                task.record({ tool, args, ok: Boolean(result?.ok), content: result?.content ?? [] });
                return result;
            };
        },

        /**
         * Runs the skill found by resolve(), updating its usage metrics.
         * @param {object} task
         * @param {{ callTool: (tool: string, args: object) => Promise<{ok: boolean, content: Array}> }} context
         * @returns {Promise<{ ok: boolean, steps?: Array, error?: string }>}
         */
        async run(task, { callTool } = {}) {
            if (!task?.skill) return { ok: false, error: "no skill to run" };
            const result = await runSkill(task.skill, task.parameters, { callTool, root });
            recordUsage(task.skill.intent, { ok: result.ok }, root);
            return result;
        },

        /**
         * If the run succeeded, compiles the procedure and registers it.
         * @param {object} task the very object returned by resolve()
         * @returns {{ saved: object|null, reason: string }}
         */
        learn(task) {
            if (!task?.intent) return { saved: null, reason: "no intent was extracted" };

            const trace = task.recorder.getTrace();
            const success = isSuccessfulRun(trace);
            if (!success.ok) return { saved: null, reason: success.reason };

            const compiled = compileProcedure({
                intent: task.intent,
                parameters: task.parameters,
                trace,
                identifiers: rules,
                runtimeImport
            });
            if (!compiled.ok) return { saved: null, reason: compiled.reason };

            return { saved: saveSkill(compiled, root), reason: "" };
        },

        /**
         * The whole flow in one call: replay a procedure already learned, or run your agent
         * with an instrumented callTool and learn from it. Equivalent to resolve + run +
         * learn, which stay available when you need to drive the steps yourself.
         * @param {string} userMessage
         * @param {{ callTool: Function, agent: (ctx: { callTool: Function, task: object }) => Promise<unknown> }} context
         * @returns {Promise<{ source: "skill"|"agent", ok: boolean, output?: unknown, skill?: object, learned?: object, task: object }>}
         */
        async handle(userMessage, { callTool, agent } = {}) {
            const task = await memory.resolve(userMessage);

            if (task.skill) {
                const skill = await memory.run(task, { callTool });
                // A failed skill is not a failed request: the caller can retry with its agent
                if (skill.ok) return { source: "skill", ok: true, output: skill.steps?.at(-1)?.content, skill, task };
                if (typeof agent !== "function") return { source: "skill", ok: false, skill, task };
            }

            if (typeof agent !== "function") {
                return { source: "agent", ok: false, task, learned: { saved: null, reason: "no agent provided" } };
            }

            const output = await agent({ callTool: memory.instrument(task, callTool), task });
            // A string answer is the end of the run; anything else the caller records itself
            if (typeof output === "string") task.recordFinalAnswer(output);

            const learned = memory.learn(task);
            return { source: "agent", ok: true, output, learned, task };
        }
    };

    return memory;
}
