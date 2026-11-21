import { DeliveryPhase } from "../domain/state-machine.js";
import type { CodeChangeCheck, RequiredLenses } from "./code-change-check.js";
import { DeliveryRecordHistory, DeliveryRisk } from "./delivery-record.js";
import type { DeliveryRecordPort } from "./delivery-record.js";

/**
 * `air lenses`: the review lenses the gate will require for the delivery's
 * pull request, so the agent runs them up front instead of guessing from
 * the lens table (ADR-0017). Reads only; records nothing.
 */
export class ReadRequiredLenses {
  constructor(
    private readonly records: Pick<DeliveryRecordPort, "list">,
    private readonly check: CodeChangeCheck,
  ) {}

  async read(issue: number): Promise<RequiredLenses> {
    // Run expiry plays no part in finding the newest reports.
    const history = new DeliveryRecordHistory(
      await this.records.list(issue),
      new Date(0),
      0,
    );
    const change =
      history.latestReport(DeliveryPhase.Review)?.facts.pullRequest ??
      history.latestReport(DeliveryPhase.Build)?.facts.pullRequest;
    if (!change)
      return {
        lenses: [],
        problems: ["No pull request reported yet (report build first)"],
      };
    const risk =
      history.latestReport(DeliveryPhase.Requirements)?.facts.risk ??
      DeliveryRisk.Low;
    return this.check.required(change, risk);
  }
}
