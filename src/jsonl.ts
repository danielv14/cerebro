// Parsing + classification of raw JSONL event lines.

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

// Flatten a message's `content` into greppable plain text. Strings pass through;
// block arrays concatenate text/thinking and tag tool_use / tool_result compactly
// so they stay searchable without drowning the prose.
export const flattenContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as any;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") parts.push(b.text);
        break;
      case "thinking":
        if (typeof b.thinking === "string") parts.push(b.thinking);
        break;
      case "tool_use": {
        const input =
          b.input && typeof b.input === "object" ? JSON.stringify(b.input) : "";
        parts.push(`[tool_use:${b.name ?? "?"}] ${input}`.trimEnd());
        break;
      }
      case "tool_result": {
        const inner = flattenContent(b.content);
        const flag = b.is_error ? ":error" : "";
        parts.push(`[tool_result${flag}] ${inner}`.trimEnd());
        break;
      }
      case "image":
        parts.push("[image]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n");
};

// Keep only real conversation turns (user / assistant) in `messages`. Everything
// else is dropped, except title-bearing events which surface a session title.
// Dropping non-message events before dedup is essential: file-history-snapshot and
// friends reuse other messages' UUIDs and would otherwise cause false collisions.
export const classify = (o: any): Classified => {
  if (!o || typeof o !== "object") return { kind: "skip" };

  switch (o.type) {
    case "user":
    case "assistant": {
      if (!o.uuid || !o.message) return { kind: "skip" };
      return {
        kind: "message",
        uuid: o.uuid,
        parentUuid: o.parentUuid ?? null,
        sessionId: o.sessionId ?? null,
        role: o.type,
        text: flattenContent(o.message.content),
        ts: o.timestamp ?? null,
        cwd: o.cwd ?? null,
        gitBranch: o.gitBranch ?? null,
        isSidechain: o.isSidechain === true,
      };
    }
    case "custom-title":
      return o.customTitle
        ? { kind: "title", sessionId: o.sessionId ?? null, title: o.customTitle, priority: 3 }
        : { kind: "skip" };
    case "ai-title":
      return o.aiTitle
        ? { kind: "title", sessionId: o.sessionId ?? null, title: o.aiTitle, priority: 2 }
        : { kind: "skip" };
    case "summary":
      return o.summary
        ? { kind: "title", sessionId: o.sessionId ?? null, title: o.summary, priority: 1 }
        : { kind: "skip" };
    default:
      return { kind: "skip" };
  }
};
