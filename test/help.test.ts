import { describe, expect, test } from "bun:test";
import { commands } from "../src/cli.ts";
import { eachCommand, isGroup } from "../src/commands/command.ts";
import { HELP } from "../src/help.ts";

const labels = eachCommand(commands).map(([label]) => label);

// A group's own name, for the `cerebro digest <action>` line that points at the
// action list instead of naming one.
const known = new Set([...labels, ...commands.keys()]);

// Every `cerebro <word>` the help text spells out as an invocation, resolved to the
// label it means: one more word for a group, and a `<placeholder>` is not that word.
// Anchored so the prose that merely names cerebro is not read as a command.
const INVOCATION = /(?:^[ \t]*|\$\(|\| )cerebro ([a-z][\w-]*)(?: ([a-z][\w-]*))?/gm;

const mentioned = (help: string): string[] => {
  const out = new Set<string>();
  for (const [, name, next] of help.matchAll(INVOCATION)) {
    const node = commands.get(name!);
    const isAction = node !== undefined && isGroup(node) && next !== undefined;
    out.add(isAction ? `${name} ${next}` : name!);
  }
  return [...out];
};

describe("HELP", () => {
  test("documents every command the dispatcher knows", () => {
    expect(labels.filter((label) => !HELP.includes(`cerebro ${label}`))).toEqual([]);
  });

  test("mentions no command the dispatcher does not know", () => {
    expect(mentioned(HELP).filter((label) => !known.has(label))).toEqual([]);
  });
});
