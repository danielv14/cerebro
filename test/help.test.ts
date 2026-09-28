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

const usageBlock = (label: string): string => {
  const lines = HELP.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*cerebro ${label}( |$)`).test(line));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "" || /^\s*cerebro /.test(line));
  return [lines[start], ...rest.slice(0, end === -1 ? rest.length : end)].join("\n");
};

describe("HELP", () => {
  test("documents every command the dispatcher knows", () => {
    expect(labels.filter((label) => !HELP.includes(`cerebro ${label}`))).toEqual([]);
  });

  test("every declared flag appears in its command's usage block", () => {
    const missing = eachCommand(commands).flatMap(([label, command]) =>
      Object.keys(command.options)
        .filter((option) => !usageBlock(label).includes(`--${option}`))
        .map((option) => `${label} --${option}`),
    );
    expect(missing).toEqual([]);
  });

  test("mentions no command the dispatcher does not know", () => {
    expect(mentioned(HELP).filter((label) => !known.has(label))).toEqual([]);
  });
});
