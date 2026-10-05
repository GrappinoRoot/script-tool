// Type definitions for @script-flow/procedural-memory
// Project: https://github.com/GrappinoRoot/script-tool

/** One piece of a tool result, in the shape MCP and most tool APIs use. */
export interface ToolContentPart {
    type?: string;
    text?: string;
}

/** What your `callTool` must return. */
export interface ToolResult {
    ok: boolean;
    content?: ToolContentPart[];
}

/** Your tool executor. The library never calls a tool any other way. */
export type CallTool = (tool: string, args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

/** Your model call, in the shape of ollama.chat / chat completions. */
export type Chat = (request: {
    model?: string;
    messages: Array<{ role: string; content: string }>;
    format?: unknown;
    think?: boolean;
}) => Promise<{ message?: { content?: string } }>;

/** How to recognize an opaque identifier (a record id, a foreign key). */
export interface IdentifierRules {
    find?: (text: string) => string | null;
    replace?: (text: string, replacer: (id: string) => string) => string;
}

export interface IntentExample {
    request: string;
    intent: string;
    parameters: Record<string, string | number | boolean>;
}

export interface ProceduralMemoryOptions {
    /** Directory holding registry.json and the generated scripts. */
    root: string;
    chat?: Chat;
    model?: string;
    /** What the requests are about, injected into the classification prompt. */
    domainHint?: string;
    examples?: IntentExample[];
    identifiers?: IdentifierRules;
    /** Helper import written into generated scripts. */
    runtimeImport?: string;
    logger?: { warn?: (message: string) => void };
}

/** A step as recorded during an agent run. */
export interface RecordedStep {
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    content?: ToolContentPart[];
    skipped?: boolean;
    reason?: string;
}

export interface Trace {
    userMessage: string;
    steps: RecordedStep[];
    finalAnswer: string;
}

export interface Recorder {
    recordToolCall(step: { tool: string; args: Record<string, unknown>; ok: boolean; content?: ToolContentPart[] }): void;
    recordSkipped(info: { tool: string; reason: string }): void;
    recordFinalAnswer(text: string): void;
    getTrace(): Trace;
}

/** A skill as stored in the registry. */
export interface SkillDefinition {
    intent: string;
    description: string;
    parameters: string[];
    tools: string[];
    script: string;
    createdAt: string;
    runs?: number;
    failures?: number;
    lastRunAt?: string | null;
}

/** What `resolve()` hands back: the classified request plus its recorder. */
export interface Task {
    userMessage: string;
    intent: string | null;
    parameters: Record<string, string | number | boolean>;
    skill: SkillDefinition | null;
    record: Recorder["recordToolCall"];
    recordSkipped: Recorder["recordSkipped"];
    recordFinalAnswer: Recorder["recordFinalAnswer"];
    recorder: Recorder;
}

export interface SkillRunResult {
    ok: boolean;
    steps?: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; content?: ToolContentPart[] }>;
    failedStep?: string;
    error?: string;
}

export interface LearnResult {
    saved: SkillDefinition | null;
    reason: string;
}

/** What `handle()` returns: the outcome plus how it was produced. */
export interface HandleResult<T = unknown> {
    /** "skill" when a compiled procedure ran, "agent" when your agent did the work. */
    source: "skill" | "agent";
    ok: boolean;
    /** Your agent's return value, on the agent path. */
    output?: T;
    skill?: SkillRunResult;
    learned?: LearnResult;
    task: Task;
}

export interface ProceduralMemory {
    /** Registered skills, without their code. */
    skills(): Array<{ intent: string; description: string; parameters: string[] }>;
    /** Classifies the request and looks for a procedure already learned. */
    resolve(userMessage: string): Promise<Task>;
    /** Runs the skill found by resolve(), updating its usage metrics. */
    run(task: Task, context: { callTool: CallTool }): Promise<SkillRunResult>;
    /** If the run succeeded, compiles the procedure and registers it. */
    learn(task: Task): LearnResult;
    /** Wraps your callTool so every call is recorded on the given task. */
    instrument(task: Task, callTool: CallTool): CallTool;
    /** One-call flow: replay a known procedure, or run your agent and learn from it. */
    handle<T>(userMessage: string, context: {
        callTool: CallTool;
        agent: (context: { callTool: CallTool; task: Task }) => Promise<T> | T;
    }): Promise<HandleResult<T>>;
}

export function createProceduralMemory(options: ProceduralMemoryOptions): ProceduralMemory;

// --- Lower-level building blocks ---------------------------------------------

export function extractIntent(userMessage: string, context: {
    chat: Chat;
    knownSkills?: Array<{ intent: string; description?: string; parameters?: string[] }>;
    model?: string;
    domainHint?: string;
    examples?: IntentExample[];
    identifiers?: IdentifierRules;
    logger?: { warn?: (message: string) => void };
}): Promise<{ intent: string; parameters: Record<string, string | number | boolean> } | null>;

export function buildIntentPrompt(options?: {
    knownSkills?: Array<{ intent: string; description?: string; parameters?: string[] }>;
    domainHint?: string;
    examples?: IntentExample[];
}): string;

export function normalizeParameterValue<T extends string | number | boolean>(value: T, identifiers?: IdentifierRules): T;

export function createRecorder(userMessage: string): Recorder;
export function isSuccessfulRun(trace: Trace): { ok: boolean; reason: string };
export function successfulSteps(trace: Trace): RecordedStep[];

export function compileProcedure(input: {
    intent: string;
    parameters?: Record<string, string | number | boolean>;
    trace: Trace;
    runtimeImport?: string;
    identifiers?: IdentifierRules;
    now?: () => Date;
}): { ok: true; source: string; definition: SkillDefinition } | { ok: false; reason: string };

export function findValuePath(value: unknown, target: unknown, prefix?: string): string | null;
export function findValuePaths(value: unknown, target: unknown, prefix?: string): string[];
export const DEFAULT_RUNTIME_IMPORT: string;

export function loadRegistry(root: string): { skills: SkillDefinition[] };
export function listSkills(root: string): Array<{ intent: string; description: string; parameters: string[] }>;
export function findSkill(intent: string, root: string): SkillDefinition | null;
export function saveSkill(compiled: { definition: SkillDefinition; source: string }, root: string): SkillDefinition;
export function recordUsage(intent: string, outcome: { ok: boolean; now?: () => Date }, root: string): void;
export const REGISTRY_FILE: string;

export function runSkill(definition: SkillDefinition, params: Record<string, unknown>, context: {
    callTool: CallTool;
    root: string;
}): Promise<SkillRunResult>;

export const defaultIdentifiers: Required<IdentifierRules>;
export function resolveIdentifiers(identifiers?: IdentifierRules): Required<IdentifierRules>;

export { renderArgs, parseToolContent, getAtPath, SkillParameterError } from "./runtime.js";
