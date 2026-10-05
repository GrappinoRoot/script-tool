import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadRegistry, listSkills, findSkill, saveSkill, recordUsage } from "../src/skill-registry.mjs";
import { compileProcedure } from "../src/skill-compiler.mjs";
import { runSkill } from "../src/skill-runner.mjs";

const RUNTIME_IMPORT = new URL("../src/runtime.mjs", import.meta.url).href;

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-"));
}

const findAccount = () => compileProcedure({
    intent: "find_account",
    parameters: { name: "Acme" },
    trace: {
        userMessage: "Trova l'Account chiamato Acme",
        steps: [{
            tool: "soqlQuery",
            args: { query: "SELECT Id, Name FROM Account WHERE Name = 'Acme' LIMIT 1" },
            ok: true,
            content: [{ type: "text", text: '{"records":[{"Id":"001xx000003DGbTAAW","Name":"Acme"}]}' }]
        }]
    },
    runtimeImport: RUNTIME_IMPORT
});

test("missing or corrupted registry → no skills (never an error that breaks the agent)", () => {
    const root = tempRoot();
    assert.deepEqual(loadRegistry(root).skills, []);
    fs.writeFileSync(path.join(root, "registry.json"), "{ non json");
    assert.deepEqual(loadRegistry(root).skills, []);
    assert.equal(findSkill("find_account", root), null);
});

test("saveSkill writes script and definition, findSkill finds it back (case-insensitive)", () => {
    const root = tempRoot();
    const saved = saveSkill(findAccount(), root);

    assert.ok(fs.existsSync(path.join(root, "find_account.mjs")));
    assert.deepEqual(saved.parameters, ["name"]);
    assert.equal(saved.runs, 0);
    assert.equal(findSkill("FIND_ACCOUNT", root).script, "find_account.mjs");
    assert.deepEqual(listSkills(root)[0].parameters, ["name"]);
});

test("definition without its script on disk → no match (no failing import)", () => {
    const root = tempRoot();
    saveSkill(findAccount(), root);
    fs.rmSync(path.join(root, "find_account.mjs"));
    assert.equal(findSkill("find_account", root), null);
});

test("recompiling the same intent replaces the skill instead of duplicating it", () => {
    const root = tempRoot();
    saveSkill(findAccount(), root);
    saveSkill(findAccount(), root);
    assert.equal(loadRegistry(root).skills.length, 1);
});

test("recordUsage updates runs and failures", () => {
    const root = tempRoot();
    saveSkill(findAccount(), root);
    recordUsage("find_account", { ok: true }, root);
    recordUsage("find_account", { ok: false }, root);
    recordUsage("unknown", { ok: true }, root); // must not throw

    const [skill] = loadRegistry(root).skills;
    assert.equal(skill.runs, 2);
    assert.equal(skill.failures, 1);
    assert.ok(skill.lastRunAt);
});

test("end-to-end: compile, save and run with new parameters", async () => {
    const root = tempRoot();
    const definition = saveSkill(findAccount(), root);
    const callTool = mock.fn(async () => ({ ok: true, content: [{ type: "text", text: '{"records":[{"Id":"001yy","Name":"United Oil & Gas Corp."}]}' }] }));

    const result = await runSkill(definition, { name: "United Oil & Gas Corp." }, { callTool, root });

    assert.equal(result.ok, true);
    assert.deepEqual(callTool.mock.calls[0].arguments, [
        "soqlQuery",
        { query: "SELECT Id, Name FROM Account WHERE Name = 'United Oil & Gas Corp.' LIMIT 1" }
    ]);
});

test("two-step skill: the second step uses the id returned by the first", async () => {
    const root = tempRoot();
    const compiled = compileProcedure({
        intent: "create_task_for_account",
        parameters: { account: "Acme", subject: "Richiamare" },
        trace: {
            userMessage: "Crea un task Richiamare sull'account Acme",
            steps: [
                {
                    tool: "soqlQuery",
                    args: { query: "SELECT Id FROM Account WHERE Name = 'Acme' LIMIT 1" },
                    ok: true,
                    content: [{ type: "text", text: '{"records":[{"Id":"001xx000003DGbTAAW"}]}' }]
                },
                {
                    tool: "createSobjectRecord",
                    args: { "sobject-name": "Task", body: { Subject: "Richiamare", WhatId: "001xx000003DGbTAAW" } },
                    ok: true,
                    content: [{ type: "text", text: '{"id":"00Txx"}' }]
                }
            ]
        },
        runtimeImport: RUNTIME_IMPORT
    });
    const definition = saveSkill(compiled, root);

    const callTool = mock.fn(async (tool) => ({
        ok: true,
        content: [{ type: "text", text: tool === "soqlQuery" ? '{"records":[{"Id":"001NUOVO"}]}' : '{"id":"00TNUOVO"}' }]
    }));
    const result = await runSkill(definition, { account: "Globex", subject: "Inviare preventivo" }, { callTool, root });

    assert.equal(result.ok, true);
    assert.deepEqual(callTool.mock.calls[1].arguments[1], {
        "sobject-name": "Task",
        body: { Subject: "Inviare preventivo", WhatId: "001NUOVO" }
    });
});

test("failed step → the skill stops and reports the failure (so the host can fall back)", async () => {
    const root = tempRoot();
    const definition = saveSkill(findAccount(), root);
    const callTool = mock.fn(async () => ({ ok: false, content: [{ type: "text", text: "ERROR: MALFORMED_QUERY" }] }));

    const result = await runSkill(definition, { name: "Acme" }, { callTool, root });
    assert.equal(result.ok, false);
    assert.equal(result.failedStep, "soqlQuery");
});

test("missing parameters or missing script → error, nothing executed", async () => {
    const root = tempRoot();
    const definition = saveSkill(findAccount(), root);
    const callTool = mock.fn(async () => ({ ok: true, content: [] }));

    const missing = await runSkill(definition, {}, { callTool, root });
    assert.match(missing.error, /missing parameters: name/);

    const absent = await runSkill({ ...definition, script: "assente.mjs" }, { name: "x" }, { callTool, root });
    assert.match(absent.error, /script not found/);
    assert.equal(callTool.mock.callCount(), 0);
});

test("end-to-end on a real trace: a two-hop write procedure replayed on another record", async () => {
    const root = tempRoot();
    // Trace of a real run: the agent gets one field wrong, corrects itself and completes
    const compiled = compileProcedure({
        intent: "create_task_for_opportunity",
        parameters: { opportunity_id: "006Qy00000RoX4eIAF" },
        trace: {
            userMessage: "Crea un task per l'account con l'Opportunity 006Qy00000RoX4eIAF",
            steps: [
                {
                    tool: "soqlQuery",
                    args: { q: "SELECT Id, AccountId FROM Opportunity WHERE Id = '006Qy00000RoX4eIAF' LIMIT 1" },
                    ok: true,
                    content: [{ type: "text", text: '{"records":[{"Id":"006Qy00000RoX4eIAF","AccountId":"001Qy000022n1yZIAQ"}]}' }]
                },
                {
                    tool: "createSobjectRecord",
                    args: { "sobject-name": "Task", body: { Subject: "Follow up", WhatId: "001Qy000022n1yZIAQ", WhoId: "005Qy00001dVGG1IAO" } },
                    ok: false,
                    content: [{ type: "text", text: "FIELD_INTEGRITY_EXCEPTION" }]
                },
                {
                    tool: "createSobjectRecord",
                    args: { "sobject-name": "Task", body: { Subject: "Follow up", WhatId: "001Qy000022n1yZIAQ" } },
                    ok: true,
                    content: [{ type: "text", text: '{"id":"00TQy00000EVCmPMAX"}' }]
                }
            ]
        },
        runtimeImport: RUNTIME_IMPORT
    });
    const definition = saveSkill(compiled, root);

    // Replay on another record, which belongs to a different parent
    const callTool = mock.fn(async (tool) => ({
        ok: true,
        content: [{ type: "text", text: tool === "soqlQuery"
            ? '{"records":[{"Id":"006ALTRA0000000001","AccountId":"001ALTRO0000000001"}]}'
            : '{"id":"00TNUOVO000000001"}' }]
    }));
    const result = await runSkill(definition, { opportunity_id: "006ALTRA0000000001" }, { callTool, root });

    assert.equal(result.ok, true);
    assert.equal(callTool.mock.callCount(), 2, "the failed attempt is not replayed");
    assert.match(callTool.mock.calls[0].arguments[1].q, /Id = '006ALTRA0000000001'/);
    assert.deepEqual(callTool.mock.calls[1].arguments[1], {
        "sobject-name": "Task",
        body: { Subject: "Follow up", WhatId: "001ALTRO0000000001" } // parent of the new record
    });
});
