import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommandParseError,
  CommentCommandParser,
  formatCommand,
} from "./comment-command-parser.js";
import { DeliveryAction, DeliveryPhase } from "../domain/state-machine.js";

const parser = () => new CommentCommandParser();

describe("CommentCommandParser", () => {
  for (const [body, action] of [
    ["/air initialize", DeliveryAction.Initialize],
    ["/air rework", DeliveryAction.Rework],
    ["/air unblock", DeliveryAction.Retry],
    ["/air recover", DeliveryAction.Recover],
    ["/air close", DeliveryAction.Close],
  ] as const) {
    it(`maps "${body}" to ${action}`, () => {
      const result = parser().parse(body);

      assert.deepEqual(result, { ok: true, command: { action, reason: "" } });
    });
  }

  it("parses an advance target and the reason after the command line", () => {
    const body = "\n  /air advance build  \nSmall task.\n\nMini-design above.";

    const result = parser().parse(body);

    assert.deepEqual(result, {
      ok: true,
      command: {
        action: DeliveryAction.Advance,
        target: DeliveryPhase.Build,
        reason: "Small task.\n\nMini-design above.",
      },
    });
  });

  it("accepts commands regardless of letter case", () => {
    const result = parser().parse("/AIR Advance Review");

    assert.equal(result.ok && result.command.target, DeliveryPhase.Review);
  });

  for (const [body, error] of [
    ["/air deploy-prod", CommandParseError.UnknownCommand],
    ["/air start", CommandParseError.UnknownCommand],
    ["/air", CommandParseError.UnknownCommand],
    ["/air advance", CommandParseError.MissingTarget],
    ["/air advance production", CommandParseError.UnknownPhase],
    ["/air rework now", CommandParseError.UnexpectedArgument],
    ["/air advance build now", CommandParseError.UnexpectedArgument],
  ] as const) {
    it(`rejects "${body}" as ${error}`, () => {
      const result = parser().parse(body);

      assert.equal(!result.ok && result.error, error);
    });
  }

  it("recognizes only comments whose first non-blank line is a command", () => {
    const recognized = [
      "/air rework",
      "\n\n/air close",
      "/air",
      "/AIR unblock",
    ].map((body) => parser().recognizes(body));
    const ignored = [
      "Looks good",
      "Run /air rework later",
      "/airplane",
      "",
      "> /air rework",
    ].map((body) => parser().recognizes(body));

    assert.deepEqual(recognized, [true, true, true, true]);
    assert.deepEqual(ignored, [false, false, false, false, false]);
  });
});

describe("formatCommand", () => {
  const parser = new CommentCommandParser();

  it("formats the commands parse reads back", () => {
    for (const [action, target] of [
      [DeliveryAction.Advance, DeliveryPhase.Review],
      [DeliveryAction.Rework, undefined],
      [DeliveryAction.Retry, undefined],
      [DeliveryAction.Close, undefined],
      [DeliveryAction.Initialize, undefined],
      [DeliveryAction.Recover, undefined],
    ] as const) {
      const line = formatCommand(action, target);
      assert.ok(line);
      const parsed = parser.parse(line);
      assert.ok(parsed.ok, line);
      assert.equal(parsed.command.action, action);
      assert.equal(parsed.command.target, target);
    }
  });

  it("has no command for agent, gate or deployment actions", () => {
    assert.equal(formatCommand(DeliveryAction.Start), null);
    assert.equal(formatCommand(DeliveryAction.DeployStage), null);
  });
});
