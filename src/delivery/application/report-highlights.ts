import {
  MAX_HIGHLIGHT_LENGTH,
  MAX_HIGHLIGHTS,
  isHighlight,
} from "./delivery-record.js";

const HEADING = /^##\s+summary\s*$/i;
const BULLET = /^[-*]\s+(.*)$/;

export type HighlightsResult =
  | Readonly<{ ok: true; highlights: readonly string[] }>
  | Readonly<{ ok: false; problem: string }>;

const USAGE = `Start the report with \`## Summary\` and one to ${MAX_HIGHLIGHTS} bullets of one line each`;

/**
 * The gist of a report, read from its `## Summary` section: the bullet
 * lines right under the heading. They become a signed report fact, so an
 * approver and the console see them without reading the whole report.
 */
export class ReportHighlights {
  read(summary: string): HighlightsResult {
    const lines = summary.split(/\r?\n/).map((line) => line.trim());
    const heading = lines.findIndex((line) => HEADING.test(line));
    if (heading === -1) return { ok: false, problem: USAGE };
    const after = lines.slice(heading + 1);
    const first = after.findIndex((line) => line !== "");
    const bullets: string[] = [];
    for (const line of first === -1 ? [] : after.slice(first)) {
      const bullet = BULLET.exec(line);
      if (!bullet) break;
      bullets.push(bullet[1]!.trim());
    }
    if (bullets.length === 0 || bullets.length > MAX_HIGHLIGHTS)
      return { ok: false, problem: USAGE };
    const bad = bullets.findIndex((bullet) => !isHighlight(bullet));
    if (bad !== -1)
      return {
        ok: false,
        problem: `Summary bullet ${bad + 1} must be one line of at most ${MAX_HIGHLIGHT_LENGTH} characters`,
      };
    return { ok: true, highlights: bullets };
  }
}
