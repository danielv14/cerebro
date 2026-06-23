// Parsing + classification of raw JSONL event lines.
//
// This is one of cerebro's two untrusted I/O boundaries (the other is the hook
// stdin payload in cli.ts): the session JSONL is produced by Claude Code, a tool we
// do not control and whose format evolves. The accepted shapes are declared once as
// Valibot schemas and validated with safeParse, never a throwing parse, so the
// parser stays deliberately tolerant: an unknown event type classifies to `skip`,
// missing optional fields default to null, and an unrecognized content block is
// dropped. Extra/unknown keys are ignored (v.object is non-strict), so a new field
// in the log never breaks indexing.

import * as v from "valibot";

export type Classified =
  | {
      kind: "message";
      uuid: string;
      parentUuid: string | null;
      sessionId: string | null;
      role: "user" | "assistant";
      text: string;
      ts: string | null;
      cwd: string | null;
      gitBranch: string | null;
      isSidechain: boolean;
    }
  | { kind: "title"; sessionId: string | null; title: string; priority: number }
  | { kind: "skip" };

// The accepted event shape, as a discriminated variant over `type`. user/assistant
// carry a message; the three title-bearing events carry their title field. An
// unknown `type`, a non-object, or a missing required field fails safeParse and
// classify returns `skip`.
//
// For the message variant only `type`, `uuid`, and `message` are load-bearing (the
// same fields the old `if (!o.uuid || !o.message)` guard required). The optional
// scalars stay permissive (`unknown`, coerced in the mapping below) instead of typed,
// so a future Claude Code change to one of those field *types* defaults that field
// and still archives the turn, rather than failing the whole variant and dropping the
// message. That is the "tolerant to an evolving log" contract this boundary exists to
// keep: skip the unknown type, default the bad field, never silently lose a turn.
const EventSchema = v.variant("type", [
  v.object({
    type: v.picklist(["user", "assistant"]),
    uuid: v.string(),
    message: v.object({ content: v.unknown() }),
    parentUuid: v.optional(v.unknown()),
    sessionId: v.optional(v.unknown()),
    timestamp: v.optional(v.unknown()),
    cwd: v.optional(v.unknown()),
    gitBranch: v.optional(v.unknown()),
    isSidechain: v.optional(v.unknown()),
  }),
  v.object({
    type: v.literal("custom-title"),
    customTitle: v.optional(v.string()),
    sessionId: v.nullish(v.string(), null),
  }),
  v.object({
    type: v.literal("ai-title"),
    aiTitle: v.optional(v.string()),
    sessionId: v.nullish(v.string(), null),
  }),
  v.object({
    type: v.literal("summary"),
    summary: v.optional(v.string()),
    sessionId: v.nullish(v.string(), null),
  }),
]);

// The accepted content-block shapes, as a union over `type`. The schema supplies
// typed shape only; the flattening transformation in flattenContent stays
// hand-written. An unrecognized block fails safeParse and is skipped.
const BlockSchema = v.variant("type", [
  v.object({ type: v.literal("text"), text: v.optional(v.string()) }),
  v.object({ type: v.literal("thinking"), thinking: v.optional(v.string()) }),
  v.object({
    type: v.literal("tool_use"),
    name: v.optional(v.string()),
    input: v.optional(v.unknown()),
  }),
  v.object({
    type: v.literal("tool_result"),
    content: v.unknown(),
    is_error: v.optional(v.boolean()),
  }),
  v.object({ type: v.literal("image") }),
]);

// Returns `undefined` (never a valid JSON value) on parse failure, so callers can
// distinguish a malformed line from a line that legitimately parses to a falsy
// value like 0, false, or null.
export const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

// Tool plumbing (file reads, bash output, grep dumps, large Edit/Write payloads)
// dominates raw transcript bytes and ages worst: it is reproducible and clutters
// search relevance. We keep the head of each tool block so the searchable bit (tool
// name, file_path, command, the first lines a reply refers to) survives while the
// bulk is dropped. JSON serializes the identifier first, so the head is the useful
// part. Errors are exempt: they are tiny and a truncated stack trace is useless.
const TOOL_TEXT_CAP = 1000;
const capToolText = (rendered: string): string =>
  rendered.length <= TOOL_TEXT_CAP
    ? rendered
    : `${rendered.slice(0, TOOL_TEXT_CAP)} [+${rendered.length - TOOL_TEXT_CAP} chars truncated]`;

// Flatten a message's `content` into greppable plain text. Strings pass through;
// block arrays concatenate text/thinking and tag tool_use / tool_result compactly
// so they stay searchable without drowning the prose. Each block is validated by
// BlockSchema (unrecognized blocks are skipped); the capping, tagging, and recursion
// over nested tool_result content stay hand-written here, not in the schema. Tool
// blocks are capped (see capToolText) so a single grep dump or Write payload cannot
// bloat the archive.
export const flattenContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    const parsed = v.safeParse(BlockSchema, block);
    if (!parsed.success) continue;
    const b = parsed.output;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") parts.push(b.text);
        break;
      case "thinking":
        if (typeof b.thinking === "string") parts.push(b.thinking);
        break;
      case "tool_use": {
        const input = b.input && typeof b.input === "object" ? JSON.stringify(b.input) : "";
        parts.push(capToolText(`[tool_use:${b.name ?? "?"}] ${input}`.trimEnd()));
        break;
      }
      case "tool_result": {
        const inner = flattenContent(b.content);
        if (b.is_error) {
          parts.push(`[tool_result:error] ${inner}`.trimEnd());
        } else {
          parts.push(capToolText(`[tool_result] ${inner}`.trimEnd()));
        }
        break;
      }
      case "image":
        parts.push("[image]");
        break;
    }
  }
  return parts.join("\n");
};

// Coerce a permissive optional field to the Classified contract: a string passes
// through, anything else (missing, null, or a wrong type from an evolving log)
// defaults to null. This is the historic `?? null` made type-honest.
const asStringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

// Keep only real conversation turns (user / assistant) in `messages`. Everything
// else is dropped, except title-bearing events which surface a session title.
// Dropping non-message events before dedup is essential: file-history-snapshot and
// friends reuse other messages' UUIDs and would otherwise cause false collisions.
// Validation declares the accepted shape; the title-priority numbers, the role
// passthrough, the optional-scalar coercion, and the call into flattenContent are
// business mapping and stay here.
export const classify = (raw: unknown): Classified => {
  const parsed = v.safeParse(EventSchema, raw);
  if (!parsed.success) return { kind: "skip" };
  const event = parsed.output;

  switch (event.type) {
    case "user":
    case "assistant":
      return {
        kind: "message",
        uuid: event.uuid,
        parentUuid: asStringOrNull(event.parentUuid),
        sessionId: asStringOrNull(event.sessionId),
        role: event.type,
        text: flattenContent(event.message.content),
        ts: asStringOrNull(event.timestamp),
        cwd: asStringOrNull(event.cwd),
        gitBranch: asStringOrNull(event.gitBranch),
        isSidechain: event.isSidechain === true,
      };
    case "custom-title":
      return event.customTitle
        ? { kind: "title", sessionId: event.sessionId, title: event.customTitle, priority: 3 }
        : { kind: "skip" };
    case "ai-title":
      return event.aiTitle
        ? { kind: "title", sessionId: event.sessionId, title: event.aiTitle, priority: 2 }
        : { kind: "skip" };
    case "summary":
      return event.summary
        ? { kind: "title", sessionId: event.sessionId, title: event.summary, priority: 1 }
        : { kind: "skip" };
  }
};
