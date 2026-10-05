import { test } from "node:test";
import assert from "node:assert/strict";
import { compileProcedure, findValuePath } from "../src/skill-compiler.mjs";

const soqlResult = (records) => [{ type: "text", text: JSON.stringify({ records }) }];

const findAccountTrace = {
    userMessage: "Trova l'Account chiamato Acme",
    steps: [{
        tool: "soqlQuery",
        args: { query: "SELECT Id, Name FROM Account WHERE Name = 'Acme' LIMIT 1" },
        ok: true,
        content: soqlResult([{ Id: "001xx000003DGbTAAW", Name: "Acme" }])
    }]
};

test("single-step procedure: the request value becomes a placeholder", () => {
    const compiled = compileProcedure({
        intent: "find_account",
        parameters: { name: "Acme" },
        trace: findAccountTrace,
        runtimeImport: "../../src/skill-runtime.mjs"
    });

    assert.equal(compiled.ok, true);
    assert.match(compiled.source, /WHERE Name = '\{\{name\}\}'/);
    assert.match(compiled.source, /compiled automatically by @script-flow\/procedural-memory/);
    assert.ok(!compiled.source.includes("'Acme'"), "the literal value must not remain in the script");
    assert.deepEqual(compiled.definition.parameters, ["name"]);
    assert.deepEqual(compiled.definition.tools, ["soqlQuery"]);
    assert.equal(compiled.definition.script, "find_account.mjs");
});

test("two-step procedure: the id read in step one becomes a reference, not a literal", () => {
    const compiled = compileProcedure({
        intent: "create_task_for_account",
        parameters: { account: "Acme", subject: "Richiamare il cliente" },
        trace: {
            userMessage: "Crea un task 'Richiamare il cliente' sull'account Acme",
            steps: [
                findAccountTrace.steps[0],
                {
                    tool: "createSobjectRecord",
                    args: { "sobject-name": "Task", body: { Subject: "Richiamare il cliente", WhatId: "001xx000003DGbTAAW" } },
                    ok: true,
                    content: [{ type: "text", text: '{"id":"00Txx0000000001"}' }]
                }
            ]
        },
        runtimeImport: "../../src/skill-runtime.mjs"
    });

    assert.equal(compiled.ok, true);
    const steps = JSON.parse(compiled.source.match(/const STEPS = (\[[\s\S]*?\]);/)[1]);
    assert.deepEqual(steps[1].args, {
        "sobject-name": "Task",  // constant of the procedure: stays literal
        body: { Subject: "{{subject}}", WhatId: { $from: { step: 0, path: "records.0.Id" } } }
    });
});

test("identifier not derivable from the request → compilation refused", () => {
    const compiled = compileProcedure({
        intent: "update_opportunity",
        parameters: { stage: "Closed Won" },
        trace: {
            userMessage: "Metti l'opportunity a Closed Won",
            steps: [{
                tool: "updateSobjectRecord",
                args: { "sobject-name": "Opportunity", "record-id": "006xx000004TmiQAAS", body: { StageName: "Closed Won" } },
                ok: true,
                content: [{ type: "text", text: "{}" }]
            }]
        }
    });

    assert.equal(compiled.ok, false);
    assert.match(compiled.reason, /006xx000004TmiQAAS/);
});

test("parameter never used → compilation refused (the skill would ignore the request)", () => {
    const compiled = compileProcedure({
        intent: "find_account",
        parameters: { name: "Acme", industry: "Banking" },
        trace: findAccountTrace
    });

    assert.equal(compiled.ok, false);
    assert.match(compiled.reason, /industry/);
});

test("empty trace or invalid intent → no script", () => {
    assert.match(compileProcedure({ intent: "find_account", trace: { userMessage: "x", steps: [] } }).reason, /empty trace/);
    assert.match(compileProcedure({ intent: "Find Account", trace: findAccountTrace }).reason, /invalid intent/);
});

test("the generated script is valid JavaScript and exports the procedure", async () => {
    const { source } = compileProcedure({
        intent: "find_account",
        parameters: { name: "Acme" },
        trace: findAccountTrace,
        runtimeImport: new URL("../src/runtime.mjs", import.meta.url).href
    });
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    assert.equal(module.intent, "find_account");
    assert.deepEqual(module.parameters, ["name"]);
    assert.equal(typeof module.run, "function");
});

test("findValuePath locates the path of a scalar value", () => {
    assert.equal(findValuePath({ records: [{ Id: "001" }] }, "001"), "records.0.Id");
    assert.equal(findValuePath({ records: [] }, "001"), null);
});

test("failed steps are dropped: the working procedure is compiled, not the attempts", () => {
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
                {   // failed attempt: wrong field type, nothing changed on the backend
                    tool: "createSobjectRecord",
                    args: { "sobject-name": "Task", body: { Subject: "Follow up", WhatId: "001Qy000022n1yZIAQ", WhoId: "005Qy00001dVGG1IAO" } },
                    ok: false,
                    content: [{ type: "text", text: "FIELD_INTEGRITY_EXCEPTION" }]
                },
                {   // the model's correction
                    tool: "createSobjectRecord",
                    args: { "sobject-name": "Task", body: { Subject: "Follow up", WhatId: "001Qy000022n1yZIAQ" } },
                    ok: true,
                    content: [{ type: "text", text: '{"id":"00TQy00000EVCmPMAX"}' }]
                }
            ]
        },
        runtimeImport: "../../src/skill-runtime.mjs"
    });

    assert.equal(compiled.ok, true, compiled.reason);
    const steps = JSON.parse(compiled.source.match(/const STEPS = (\[[\s\S]*?\n\]);/)[1]);
    assert.equal(steps.length, 2, "the failed attempt must not reach the script");
    assert.equal(steps[0].args.q, "SELECT Id, AccountId FROM Opportunity WHERE Id = '{{opportunity_id}}' LIMIT 1");
    // the parent id is not in the request: it must come from the first step's result
    assert.deepEqual(steps[1].args.body.WhatId, { $from: { step: 0, path: "records.0.AccountId" } });
});

test("identifier typed by the user but not extracted as a parameter → refused (never baked in)", () => {
    const compiled = compileProcedure({
        intent: "create_task_for_account",
        parameters: { name: "Follow-up su Opportunità" },
        trace: {
            userMessage: "Crea un task per l'account con l'Opportunity 006Qy00000RoX4eIAF",
            steps: [{
                tool: "createSobjectRecord",
                args: { "sobject-name": "Task", body: { Subject: "Follow-up su Opportunità", WhatId: "006Qy00000RoX4eIAF" } },
                ok: true,
                content: [{ type: "text", text: '{"id":"00TQy00000EVCzJMAX"}' }]
            }]
        }
    });

    assert.equal(compiled.ok, false);
    assert.match(compiled.reason, /006Qy00000RoX4eIAF/);
});

test("identifier nested in a query → reference to the step that produced it, not a literal", () => {
    const compiled = compileProcedure({
        intent: "create_task_for_opportunity",
        parameters: { opportunity_id: "006Qy00000RoX4eIAF" },
        trace: {
            userMessage: "Crea un task per l'account dell'Opportunity 006Qy00000RoX4eIAF",
            steps: [
                {
                    tool: "soqlQuery",
                    args: { q: "SELECT Id, AccountId FROM Opportunity WHERE Id = '006Qy00000RoX4eIAF' LIMIT 1" },
                    ok: true,
                    content: [{ type: "text", text: '{"records":[{"Id":"006Qy00000RoX4eIAF","AccountId":"001Qy000022n1yZIAQ"}]}' }]
                },
                {
                    tool: "soqlQuery",
                    args: { q: "SELECT Id, Name FROM Account WHERE Id = '001Qy000022n1yZIAQ' LIMIT 1" },
                    ok: true,
                    content: [{ type: "text", text: '{"records":[{"Id":"001Qy000022n1yZIAQ","Name":"Dickenson plc"}]}' }]
                }
            ]
        },
        runtimeImport: "../../src/skill-runtime.mjs"
    });

    assert.equal(compiled.ok, true, compiled.reason);
    const steps = JSON.parse(compiled.source.match(/const STEPS = (\[[\s\S]*?\n\]);/)[1]);
    assert.equal(steps[1].args.q, "SELECT Id, Name FROM Account WHERE Id = '{{@0.records.0.AccountId}}' LIMIT 1");
});

test("identifier nested in a query but not derivable → compilation refused", () => {
    const compiled = compileProcedure({
        intent: "find_tasks",
        parameters: { subject: "Follow up" },
        trace: {
            userMessage: "Trova i task con subject Follow up",
            steps: [{
                tool: "soqlQuery",
                args: { q: "SELECT Id FROM Task WHERE Subject = 'Follow up' AND WhatId = '001Qy000022n1yZIAQ'" },
                ok: true,
                content: [{ type: "text", text: '{"records":[]}' }]
            }]
        }
    });

    assert.equal(compiled.ok, false);
    assert.match(compiled.reason, /001Qy000022n1yZIAQ/);
});

test("a long enum value is not mistaken for an identifier", () => {
    const compiled = compileProcedure({
        intent: "find_accounts_by_industry",
        parameters: { industry: "Telecommunications" },
        trace: {
            userMessage: "Trova gli account con Industry Telecommunications",
            steps: [{
                tool: "soqlQuery",
                args: { q: "SELECT Id FROM Account WHERE Industry = 'Telecommunications'" },
                ok: true,
                content: [{ type: "text", text: '{"records":[]}' }]
            }]
        },
        runtimeImport: "../../src/skill-runtime.mjs"
    });

    assert.equal(compiled.ok, true, compiled.reason);
    assert.match(compiled.source, /Industry = '\{\{industry\}\}'/);
});

test("numbers coming from an earlier step become references, not constants", () => {
    const compiled = compileProcedure({
        intent: "weather_report",
        parameters: { city: "Roma" },
        trace: {
            userMessage: "Che tempo fa a Roma",
            steps: [
                { tool: "geocode", args: { city: "Roma" }, ok: true, content: [{ type: "text", text: '{"lat":41.9,"lon":12.5}' }] },
                { tool: "forecast", args: { lat: 41.9, lon: 12.5, days: 3 }, ok: true, content: [{ type: "text", text: '{"tempC":21}' }] }
            ]
        },
        runtimeImport: "../../src/runtime.mjs"
    });

    assert.equal(compiled.ok, true, compiled.reason);
    const steps = JSON.parse(compiled.source.match(/const STEPS = (\[[\s\S]*?\n\]);/)[1]);
    assert.deepEqual(steps[1].args, {
        lat: { $from: { step: 0, path: "lat" } },
        lon: { $from: { step: 0, path: "lon" } },
        days: 3   // small integer: an option of the procedure, not a value read from a result
    });
});

test("booleans and ambiguous values stay constant", () => {
    const compiled = compileProcedure({
        intent: "list_orders",
        parameters: { customer: "Acme" },
        trace: {
            userMessage: "Elenca gli ordini di Acme",
            steps: [
                { tool: "findCustomer", args: { name: "Acme" }, ok: true, content: [{ type: "text", text: '{"active":true,"score":77,"rank":77}' }] },
                { tool: "listOrders", args: { includeArchived: true, threshold: 77 }, ok: true, content: [{ type: "text", text: "[]" }] }
            ]
        },
        runtimeImport: "../../src/runtime.mjs"
    });

    const steps = JSON.parse(compiled.source.match(/const STEPS = (\[[\s\S]*?\n\]);/)[1]);
    assert.equal(steps[1].args.includeArchived, true, "a boolean is a flag, not a value read from a result");
    assert.equal(steps[1].args.threshold, 77, "value present twice in the result: ambiguous, stays constant");
});

test("a number asked for by the user becomes a parameter", () => {
    const compiled = compileProcedure({
        intent: "list_recent",
        parameters: { howMany: 25 },
        trace: {
            userMessage: "Mostrami gli ultimi 25 record",
            steps: [{ tool: "listRecent", args: { limit: 25 }, ok: true, content: [{ type: "text", text: "[]" }] }]
        },
        runtimeImport: "../../src/runtime.mjs"
    });

    assert.equal(compiled.ok, true, compiled.reason);
    assert.match(compiled.source, /"limit": "\{\{howMany\}\}"/);
});
