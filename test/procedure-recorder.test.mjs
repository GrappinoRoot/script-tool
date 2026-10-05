import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecorder, isSuccessfulRun, successfulSteps } from "../src/procedure-recorder.mjs";

function okRecorder() {
    const recorder = createRecorder("Trova l'Account chiamato Acme");
    recorder.recordToolCall({ tool: "soqlQuery", args: { query: "SELECT Id FROM Account" }, ok: true, content: [{ type: "text", text: "{}" }] });
    recorder.recordFinalAnswer("Account trovato: Acme");
    return recorder;
}

test("successful run: complete trace and positive check", () => {
    const trace = okRecorder().getTrace();
    assert.equal(trace.userMessage, "Trova l'Account chiamato Acme");
    assert.equal(trace.steps.length, 1);
    assert.deepEqual(isSuccessfulRun(trace), { ok: true, reason: "" });
});

test("no tool executed → not recordable", () => {
    const recorder = createRecorder("Ciao");
    recorder.recordFinalAnswer("Ciao!");
    assert.equal(isSuccessfulRun(recorder.getTrace()).ok, false);
});

test("step blocked by a guard → not recordable", () => {
    const recorder = okRecorder();
    recorder.recordSkipped({ tool: "createSobjectRecord", reason: "BLOCKED: confidence bassa" });
    const result = isSuccessfulRun(recorder.getTrace());
    assert.equal(result.ok, false);
    assert.match(result.reason, /createSobjectRecord/);
});

test("only failed tools → not recordable", () => {
    const recorder = createRecorder("x");
    recorder.recordToolCall({ tool: "soqlQuery", args: {}, ok: false, content: [] });
    recorder.recordFinalAnswer("non ci sono riuscito");
    assert.match(isSuccessfulRun(recorder.getTrace()).reason, /no tool succeeded/);
});

test("failed then corrected tool → recordable, and only the successful call is compiled", () => {
    const recorder = createRecorder("Crea un task");
    recorder.recordToolCall({ tool: "createSobjectRecord", args: { body: { WhoId: "sbagliato" } }, ok: false, content: [] });
    recorder.recordToolCall({ tool: "createSobjectRecord", args: { body: { Subject: "ok" } }, ok: true, content: [] });
    recorder.recordFinalAnswer("Task creato");

    const trace = recorder.getTrace();
    assert.equal(isSuccessfulRun(trace).ok, true);
    assert.deepEqual(successfulSteps(trace).map(step => step.args), [{ body: { Subject: "ok" } }]);
});

test("no final answer (interrupted loop) → not recordable", () => {
    const recorder = createRecorder("x");
    recorder.recordToolCall({ tool: "soqlQuery", args: {}, ok: true, content: [] });
    assert.match(isSuccessfulRun(recorder.getTrace()).reason, /final answer/);
});

test("the returned trace is a copy: it does not mutate while the run continues", () => {
    const recorder = okRecorder();
    const trace = recorder.getTrace();
    recorder.recordToolCall({ tool: "find", args: {}, ok: true, content: [] });
    assert.equal(trace.steps.length, 1);
});
