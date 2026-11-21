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
const words: ReadonlyMap<Action, string> = new Map(
  Object.entries(actions).map(([word, action]) => [action, word]),
);

/**
 * The command line a person posts for `action`, exactly as `parse` reads it
 * back; null for actions no person can request by comment.
 */
export function formatCommand(action: Action, target?: Phase): string | null {
  const word = words.get(action);
  if (!word) return null;
  return target ? `${prefix} ${word} ${target}` : `${prefix} ${word}`;
}

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
        `Expected one of: ${[...Object.keys(actions), ...Object.values(ApprovalCommandName)].join(", ")}`,
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

  private commandLine(body: string): readonly string[] {
    return commandLine(body);
  }

  private reason(body: string): string {
    return reason(body);
  }
}

function lines(body: string): readonly string[] {
  const all = body.split(/\r?\n/);
  const first = all.findIndex((line) => line.trim() !== "");
  return first === -1 ? [] : all.slice(first);
}

function commandLine(body: string): readonly string[] {
  const [line = ""] = lines(body);
  return line.trim().toLowerCase().split(/\s+/);
}

function reason(body: string): string {
  return lines(body).slice(1).join("\n").trim();
}

/** `/air` commands that record a decision instead of moving state. */
export const ApprovalCommandName = {
  /** Lets one pull request change protected paths at one commit (ADR-0017). */
  AllowProtected: "allow-protected",
} as const;

/** A commit as people type it: an abbreviated or full hex hash. */
const COMMIT = /^[0-9a-f]{7,64}$/;

export type ApprovalParseResult =
  | Readonly<{ ok: true; commit: string; reason: string }>
  | Readonly<{ ok: false; error: CommandParseError; detail: string }>;

/**
 * Parses `/air allow-protected <commit>` on the first non-blank line;
 * everything after it is the approver's reason. The commit is required: it
 * names what the approver reviewed, so a later push can't ride along.
 */
export class ApprovalCommand {
  static allowProtected(commit: string): string {
    return `${prefix} ${ApprovalCommandName.AllowProtected} ${commit}`;
  }

  recognizes(body: string): boolean {
    const [word, name] = commandLine(body);
    return word === prefix && name === ApprovalCommandName.AllowProtected;
  }

  parse(body: string): ApprovalParseResult {
    const [, , commit, ...extra] = commandLine(body);
    const usage = `${ApprovalCommandName.AllowProtected} <commit>`;
    if (commit === undefined)
      return {
        ok: false,
        error: CommandParseError.MissingTarget,
        detail: usage,
      };
    if (extra.length > 0)
      return {
        ok: false,
        error: CommandParseError.UnexpectedArgument,
        detail: extra.join(" "),
      };
    if (!COMMIT.test(commit))
      return {
        ok: false,
        error: CommandParseError.UnexpectedArgument,
        detail: `Not a commit: ${commit.slice(0, 64)}`,
      };
    return { ok: true, commit, reason: reason(body) };
  }
}
