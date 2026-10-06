import * as v from "valibot";
import { escapeLike } from "../like.ts";
import { type Classified, parseLine } from "./adapter.ts";

// Only `type`, `uuid` and the content field are load-bearing. The optional scalars stay
// `unknown` (coerced below) so a changed field type in an evolving log defaults
// that field instead of failing the variant and dropping the message.
const MessageFieldsSchema = v.object({
  uuid: v.string(),
  parentUuid: v.optional(v.unknown()),
  sessionId: v.optional(v.unknown()),
  timestamp: v.optional(v.unknown()),
  cwd: v.optional(v.unknown()),
  gitBranch: v.optional(v.unknown()),
  isSidechain: v.optional(v.unknown()),
});

const EventSchema = v.variant("type", [
  v.object({
    type: v.picklist(["user", "assistant"]),
    message: v.object({ content: v.unknown(), model: v.optional(v.unknown()) }),
    ...MessageFieldsSchema.entries,
  }),
  // A prompt queued while the agent is busy, usually typed by the user. The other
  // commandModes are task-notifications and coordinator instructions to a subagent.
  v.object({
    type: v.literal("attachment"),
    attachment: v.object({
      type: v.literal("queued_command"),
      commandMode: v.literal("prompt"),
      prompt: v.unknown(),
    }),
    ...MessageFieldsSchema.entries,
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

export function* classifyLines(lines: string[]): Generator<Classified> {
  for (const line of lines) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed === undefined) continue;
    yield classify(parsed);
  }
}

// The head of a tool payload carries the searchable identifiers; the bulk is
// reproducible plumbing.
const TOOL_TEXT_CAP = 1000;
const capToolText = (rendered: string): string =>
  rendered.length <= TOOL_TEXT_CAP
    ? rendered
    : `${rendered.slice(0, TOOL_TEXT_CAP)} [+${rendered.length - TOOL_TEXT_CAP} chars truncated]`;

// Every tool block opens with this, and the source-agnostic queries (search
// --prose, skills, the opening prompt) tell tool output from prose by it alone.
const TOOL_TAG_OPEN = "[tool_";

export const toolUseTag = (name: string): string => `${TOOL_TAG_OPEN}use:${name}]`;

// `column` is a codebase literal, never user input.
export const isToolText = (column: string): string =>
  `${column} LIKE '${escapeLike(TOOL_TAG_OPEN)}%' ESCAPE '\\'`;

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
        parts.push(capToolText(`${toolUseTag(b.name ?? "?")} ${input}`.trimEnd()));
        break;
      }
      case "tool_result": {
        const inner = flattenContent(b.content);
        if (b.is_error) {
          // Deliberately uncapped: errors are tiny and a truncated stack trace
          // is useless.
          parts.push(`${TOOL_TAG_OPEN}result:error] ${inner}`.trimEnd());
        } else {
          parts.push(capToolText(`${TOOL_TAG_OPEN}result] ${inner}`.trimEnd()));
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

const asStringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const messageEnvelope = (event: v.InferOutput<typeof MessageFieldsSchema>) => ({
  kind: "message" as const,
  uuid: event.uuid,
  parentUuid: asStringOrNull(event.parentUuid),
  sessionId: asStringOrNull(event.sessionId),
  ts: asStringOrNull(event.timestamp),
  cwd: asStringOrNull(event.cwd),
  gitBranch: asStringOrNull(event.gitBranch),
  isSidechain: event.isSidechain === true,
});

// Dropping non-message events before dedup is essential (invariant #5):
// file-history-snapshot and friends reuse other messages' UUIDs.
export const classify = (raw: unknown): Classified => {
  const parsed = v.safeParse(EventSchema, raw);
  if (!parsed.success) return { kind: "skip" };
  const event = parsed.output;

  switch (event.type) {
    case "user":
    case "assistant":
      return {
        ...messageEnvelope(event),
        role: event.type,
        text: flattenContent(event.message.content),
        // "<synthetic>" is Claude Code's stamp on interrupted/API-error turns; no
        // model served those, so they must not become the session's model.
        model: event.message.model === "<synthetic>" ? null : asStringOrNull(event.message.model),
      };
    case "attachment":
      return {
        ...messageEnvelope(event),
        role: "user",
        text: flattenContent(event.attachment.prompt),
        model: null,
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
