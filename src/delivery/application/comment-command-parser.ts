import { DeliveryAction, DeliveryPhase } from "../domain/state-machine.js";
import type { Action, Phase } from "../domain/state-machine.js";

/** Human-facing command words. Agent, gate and deployment actions are absent. */
export const CommentCommandName = {
  Initialize: "initialize",
  Advance: "advance",
  Rework: "rework",
  Unblock: "unblock",
  Recover: "recover",
  Close: "close",
} as const;

export const CommandParseError = {
  UnknownCommand: "unknown-command",
  MissingTarget: "missing-target",
  UnknownPhase: "unknown-phase",
  UnexpectedArgument: "unexpected-argument",
} as const;
export type CommandParseError =
  (typeof CommandParseError)[keyof typeof CommandParseError];

export type ParsedCommand = Readonly<{
  action: Action;
  target?: Phase;
  /** Free text after the command line; the comment itself is the record. */
  reason: string;
}>;

export type CommandParseResult =
  | Readonly<{ ok: true; command: ParsedCommand }>
  | Readonly<{ ok: false; error: CommandParseError; detail: string }>;

const actions: Readonly<Record<string, Action>> = {
  [CommentCommandName.Initialize]: DeliveryAction.Initialize,
  [CommentCommandName.Advance]: DeliveryAction.Advance,
  [CommentCommandName.Rework]: DeliveryAction.Rework,
  [CommentCommandName.Unblock]: DeliveryAction.Retry,
  [CommentCommandName.Recover]: DeliveryAction.Recover,
  [CommentCommandName.Close]: DeliveryAction.Close,
};
const phases: readonly string[] = Object.values(DeliveryPhase);
const prefix = "/air";

const failure = (
  error: CommandParseError,
  detail: string,
): CommandParseResult => ({ ok: false, error, detail });

/**
 * Parses `/air <command> [phase]` on the first non-blank line of a comment.
 * Everything after that line is the reason. Pure and deterministic.
 */
export class CommentCommandParser {
  recognizes(body: string): boolean {
    const [word] = this.commandLine(body);
    return word === prefix;
  }

  parse(body: string): CommandParseResult {
    const [word, name, argument, ...extra] = this.commandLine(body);
    const action = word === prefix ? actions[name ?? ""] : undefined;
    if (!action)
      return failure(
        CommandParseError.UnknownCommand,
        `Expected one of: ${Object.keys(actions).join(", ")}`,
      );
    if (extra.length > 0)
      return failure(CommandParseError.UnexpectedArgument, extra.join(" "));

    const reason = this.reason(body);
    if (action !== DeliveryAction.Advance)
      return argument === undefined
        ? { ok: true, command: { action, reason } }
        : failure(CommandParseError.UnexpectedArgument, argument);

    if (argument === undefined)
      return failure(CommandParseError.MissingTarget, "advance <phase>");
    if (!phases.includes(argument))
      return failure(CommandParseError.UnknownPhase, argument);
    return {
      ok: true,
      command: { action, target: argument as Phase, reason },
    };
  }

  private lines(body: string): readonly string[] {
    const lines = body.split(/\r?\n/);
    const first = lines.findIndex((line) => line.trim() !== "");
    return first === -1 ? [] : lines.slice(first);
  }

  private commandLine(body: string): readonly string[] {
    const [line = ""] = this.lines(body);
    return line.trim().toLowerCase().split(/\s+/);
  }

  private reason(body: string): string {
    return this.lines(body).slice(1).join("\n").trim();
  }
}
