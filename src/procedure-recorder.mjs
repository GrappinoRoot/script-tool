// =========================
// PROCEDURE RECORDER - trace of one agent run + success check
// =========================
// Records the procedure the agent loop actually executed (which tools, with which
// arguments, with which result). The trace is the compiler's input: only successful runs
// become skills, so the registry never learns a broken procedure.

/**
 * Creates a recorder for a single agent run.
 * @param {string} userMessage the original user request
 */
export function createRecorder(userMessage) {
    const steps = [];
    let finalAnswer = "";

    return {
        /**
         * Records a tool that was really executed (after your guards allowed it).
         * @param {{ tool: string, args: object, ok: boolean, content?: Array }} step
         */
        recordToolCall({ tool, args, ok, content }) {
            steps.push({ tool, args, ok: Boolean(ok), content: content ?? [] });
        },
        /**
         * Records a tool that was NOT executed (blocked by a guard, denied by the user,
         * malformed arguments): it makes the run non-compilable.
         * @param {{ tool: string, reason: string }} info
         */
        recordSkipped({ tool, reason }) {
            steps.push({ tool, args: {}, ok: false, skipped: true, reason, content: [] });
        },
        /** Records the model's final answer (end of the loop). */
        recordFinalAnswer(text) {
            finalAnswer = typeof text === "string" ? text.trim() : "";
        },
        /** @returns {{ userMessage: string, steps: Array, finalAnswer: string }} */
        getTrace() {
            return { userMessage, steps: [...steps], finalAnswer };
        }
    };
}

/**
 * Deterministic check that the run succeeded and may become a skill.
 * Criteria: at least one successful tool, no blocked or denied step, a final answer.
 * A failed step does NOT invalidate the run: an agent that mistypes a call and then
 * corrects itself is the normal case, and the failed attempt changed nothing. What gets
 * compiled is the working procedure (see successfulSteps), not the path taken to find it.
 * @param {{ steps: Array, finalAnswer: string }} trace
 * @returns {{ ok: boolean, reason: string }}
 */
export function isSuccessfulRun(trace) {
    const steps = trace?.steps ?? [];
    if (!steps.length) return { ok: false, reason: "no tool was executed: nothing to record" };

    const skipped = steps.find(step => step.skipped);
    if (skipped) return { ok: false, reason: `step not executed (${skipped.tool}): ${skipped.reason}` };

    if (!steps.some(step => step.ok)) {
        return { ok: false, reason: `no tool succeeded (last one: ${steps.at(-1).tool})` };
    }

    if (!trace?.finalAnswer) return { ok: false, reason: "no final answer from the model" };

    return { ok: true, reason: "" };
}

/**
 * The steps to compile: the successful ones, in their original order.
 * @param {{ steps: Array }} trace
 * @returns {Array}
 */
export function successfulSteps(trace) {
    return (trace?.steps ?? []).filter(step => step.ok);
}
