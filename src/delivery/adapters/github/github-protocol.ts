/**
 * GitHub REST vocabulary used by the adapters. Compare payload values only
 * against these names, never against inline literals.
 */
export const GitHubIssueState = { Open: "open", Closed: "closed" } as const;

export const GitHubPullRequestState = { Open: "open" } as const;

export const GitHubUserType = { Bot: "Bot" } as const;

/** Issue event types AIR reads to verify who changed delivery labels. */
export const GitHubIssueEventType = {
  Labeled: "labeled",
  Unlabeled: "unlabeled",
} as const;

export const GitHubCheckRunStatus = { Completed: "completed" } as const;

/** Check run conclusions and commit status states that count as passing. */
export const GitHubPassingCheck = {
  Success: "success",
  Neutral: "neutral",
  Skipped: "skipped",
} as const;

export const GitHubDeploymentState = { Success: "success" } as const;

export const GitHubReviewState = { Approved: "APPROVED" } as const;

/** `compare/base...head` statuses where head contains base. */
export const GitHubCompareContains = {
  Identical: "identical",
  Ahead: "ahead",
} as const;

export const values = <T extends Record<string, string>>(
  vocabulary: T,
): readonly string[] => Object.values(vocabulary);
