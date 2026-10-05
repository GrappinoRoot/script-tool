// Runtime helpers imported by the generated skills.

export class SkillParameterError extends Error {}

export function escapeEmbedded(value: unknown): string;
export function parseToolContent(content: Array<{ type?: string; text?: string }> | string | undefined): unknown;
export function getAtPath(value: unknown, dottedPath: string): unknown;
export function renderArgs(template: unknown, params?: Record<string, unknown>, stepResults?: unknown[]): unknown;
