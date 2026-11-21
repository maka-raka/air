import {
  ContentTrust,
  StateAnchorMode,
  TrustDenial,
  TrustPolicy,
} from "./trust-policy.js";
import { DeliveryPhase, DeliveryStatus } from "./state-machine.js";
import type { Phase, Position, Status } from "./state-machine.js";
import type {
  AnchorEvidence,
  StateProvenance,
  TrustDecision,
  TrustRoster,
} from "./trust-policy.js";

// Domain tests import nothing from node: (dependency-cruiser keeps the
// domain pure), so they assert by hand and fail by throwing.
let assertions = 0;
function check(condition: boolean, message: string): void {
  assertions++;
  if (!condition) throw new Error(`TrustPolicy: ${message}`);
}
function throws(build: () => unknown, message: string): void {
  let thrown = false;
  try {
    build();
  } catch {
    thrown = true;
  }
  check(thrown, message);
}

const PROJECT = 123;
const APPROVER = 7;
const OPERATOR = 9;
const AGENT = 77;
const DEPLOYER = 88;
const roster: TrustRoster = {
  sourceId: PROJECT,
  approverIds: [APPROVER],
  operatorId: OPERATOR,
  agentId: AGENT,
  deployerId: DEPLOYER,
  operatorMayApprove: false,
  stateAnchors: StateAnchorMode.Require,
};
const policy = new TrustPolicy(roster);
const denial = (decision: TrustDecision) =>
  decision.trusted ? null : decision.denial;
const detail = (decision: TrustDecision) =>
  decision.trusted ? "" : decision.detail;

// commandAuthor
check(
  policy.commandAuthor(PROJECT, APPROVER).trusted,
  "trusts an approver in the configured project",
);
for (const [name, source, author, expected] of [
  ["another project", 999, APPROVER, TrustDenial.ForeignSource],
  ["the agent", PROJECT, AGENT, TrustDenial.ServiceAccount],
  ["the deployer", PROJECT, DEPLOYER, TrustDenial.ServiceAccount],
  ["a writer not on the list", PROJECT, 8, TrustDenial.NotApprover],
  ["a non-approver operator", PROJECT, OPERATOR, TrustDenial.NotApprover],
] as const)
  check(
    denial(policy.commandAuthor(source, author)) === expected,
    `denies ${name}`,
  );
check(
  denial(
    new TrustPolicy({ ...roster, approverIds: [] }).commandAuthor(
      PROJECT,
      APPROVER,
    ),
  ) === TrustDenial.NotApprover,
  "denies every command when there are no approvers",
);
check(
  new TrustPolicy({
    ...roster,
    approverIds: [OPERATOR],
    operatorMayApprove: true,
  }).commandAuthor(PROJECT, OPERATOR).trusted,
  "trusts the operator only when explicitly allowed to approve",
);

// commandAccess
check(
  policy.commandAccess(APPROVER, { currentId: APPROVER, canWrite: true })
    .trusted,
  "trusts current write access under the same identity",
);
for (const [name, access, expected] of [
  [
    "a login of another account",
    { currentId: 99, canWrite: true },
    TrustDenial.IdentityChanged,
  ],
  [
    "a login that no longer resolves",
    { currentId: null, canWrite: false },
    TrustDenial.IdentityChanged,
  ],
  [
    "an approver without write access",
    { currentId: APPROVER, canWrite: false },
    TrustDenial.NoWriteAccess,
  ],
] as const)
  check(
    denial(policy.commandAccess(APPROVER, access)) === expected,
    `denies ${name}`,
  );

// state
const at = (phase: Phase, status: Status): Position => ({ phase, status });
const { Requirements, Build, Review, Accept, Observe } = DeliveryPhase;
const { Ready, Working, Blocked, Waiting } = DeliveryStatus;
const anchor = (
  authorId: number,
  position: Position = HERE,
): AnchorEvidence => ({
  authorId,
  edited: false,
  signatureValid: true,
  position,
});
/** What AIR writes for a small task until build starts. */
const INITIALIZED = anchor(OPERATOR, at(Requirements, Ready));
const TO_BUILD = [
  INITIALIZED,
  anchor(AGENT, at(Requirements, Working)),
  anchor(AGENT, at(Requirements, Waiting)),
  anchor(OPERATOR, at(Build, Ready)),
];
const HERE = at(Build, Working);
const EARLIER = at(Build, Ready);
/** Build ends in review; the deployer moves it on to acceptance. */
const TO_ACCEPT = [
  ...TO_BUILD,
  anchor(AGENT, HERE),
  anchor(AGENT, at(Build, Waiting)),
  anchor(OPERATOR, at(Review, Ready)),
  anchor(AGENT, at(Review, Working)),
  anchor(AGENT, at(Review, Waiting)),
  anchor(DEPLOYER, at(Accept, Ready)),
];
const by = (writerId: number, writerLogin = "air") =>
  ({ known: true, writerId, writerLogin }) as const;
const stateOf = (
  provenance: StateProvenance,
  anchors: readonly AnchorEvidence[],
  rules = policy,
  position: Position = HERE,
) => rules.state(provenance, position, anchors);

for (const [writerId, anchors] of [
  [OPERATOR, [INITIALIZED]],
  [AGENT, [...TO_BUILD, anchor(AGENT)]],
  [DEPLOYER, TO_ACCEPT],
] as const)
  check(
    stateOf(by(writerId), anchors, policy, anchors.at(-1)!.position).trusted,
    `trusts state written and anchored by service account ${writerId}`,
  );
const byPerson = stateOf(by(APPROVER, "octocat"), [anchor(APPROVER)]);
check(
  denial(byPerson) === TrustDenial.UntrustedStateWriter,
  "denies state written by a person",
);
check(detail(byPerson).includes("octocat"), "names the person");
check(
  detail(stateOf(by(0, ""), [])).includes("deleted account"),
  "names a deleted writer account",
);
const unknown = stateOf({ known: false, reason: "History cut" }, [
  anchor(OPERATOR),
]);
check(
  denial(unknown) === TrustDenial.UnknownStateWriter,
  "denies an unknown writer",
);
check(detail(unknown) === "History cut", "keeps the reason");
check(
  denial(
    stateOf(
      by(DEPLOYER),
      [anchor(DEPLOYER)],
      new TrustPolicy({ ...roster, deployerId: null }),
    ),
  ) === TrustDenial.UntrustedStateWriter,
  "does not trust a deployer that is not configured",
);

// state anchors
check(
  denial(stateOf(by(OPERATOR), [])) === TrustDenial.StateAnchorMissing,
  "requires an anchor by default",
);
for (const [name, untrusted] of [
  ["edited", { ...anchor(OPERATOR), edited: true }],
  ["badly signed", { ...anchor(OPERATOR), signatureValid: false }],
  ["by a person", anchor(APPROVER)],
] as const)
  check(
    denial(stateOf(by(OPERATOR), [untrusted])) ===
      TrustDenial.StateAnchorMissing,
    `ignores an anchor that is ${name}`,
  );
check(
  stateOf(by(AGENT), [...TO_BUILD, anchor(AGENT), anchor(APPROVER, EARLIER)])
    .trusted,
  "ignores an untrusted anchor posted after the real one",
);
check(
  denial(stateOf(by(OPERATOR), [anchor(OPERATOR, EARLIER)])) ===
    TrustDenial.StateAnchorMismatch,
  "denies when the latest anchor names another state",
);
check(
  denial(stateOf(by(OPERATOR), [anchor(OPERATOR), anchor(AGENT, EARLIER)])) ===
    TrustDenial.StateAnchorMismatch,
  "denies when a later anchor moved on (the newest one was deleted or the state rolled back)",
);
check(
  denial(stateOf(by(OPERATOR), [anchor(AGENT)])) ===
    TrustDenial.StateAnchorMismatch,
  "denies when the anchor and the stored state have different writers",
);
const bootstrap = new TrustPolicy({
  ...roster,
  stateAnchors: StateAnchorMode.Bootstrap,
});
check(
  stateOf(by(OPERATOR), [], bootstrap).trusted,
  "bootstrap trusts write history alone while an issue has no anchor",
);
check(
  denial(stateOf(by(OPERATOR), [anchor(OPERATOR, EARLIER)], bootstrap)) ===
    TrustDenial.StateAnchorMismatch,
  "bootstrap still requires a match once an issue has an anchor",
);

// state history (ADR-0010 step 7)
const historyOf = (
  writerId: number,
  anchors: readonly AnchorEvidence[],
  rules = policy,
) => stateOf(by(writerId), anchors, rules, anchors.at(-1)!.position);
for (const [name, writerId, anchors] of [
  [
    "a history without an operator anchor",
    AGENT,
    [anchor(AGENT, at(Requirements, Working))],
  ],
  [
    "a history whose operator anchor is followed by a forged move",
    AGENT,
    [
      anchor(OPERATOR, at(Requirements, Waiting)),
      anchor(AGENT, at(Accept, Waiting)),
    ],
  ],
  [
    "the agent skipping a human approval",
    AGENT,
    [INITIALIZED, anchor(AGENT, at(Accept, Waiting))],
  ],
  [
    "the agent advancing a phase",
    AGENT,
    [...TO_BUILD.slice(0, 3), anchor(AGENT, at(Build, Ready))],
  ],
  [
    "the agent passing a gate it never started",
    AGENT,
    [INITIALIZED, anchor(AGENT, at(Requirements, Waiting))],
  ],
  [
    "the operator signing the agent's start",
    OPERATOR,
    [INITIALIZED, anchor(OPERATOR, at(Requirements, Working))],
  ],
  [
    "the deployer moving a build that is not in review",
    DEPLOYER,
    [
      ...TO_BUILD,
      anchor(AGENT),
      anchor(AGENT, at(Build, Waiting)),
      anchor(DEPLOYER, at(Accept, Ready)),
    ],
  ],
  [
    "the deployer closing acceptance before it waits",
    DEPLOYER,
    [...TO_ACCEPT, anchor(DEPLOYER, at(Observe, Ready))],
  ],
  [
    "a gap where an anchor was deleted",
    OPERATOR,
    [...TO_BUILD.slice(0, 2), TO_BUILD[3]!],
  ],
  [
    "an anchor that no longer counts inside the history",
    OPERATOR,
    [TO_BUILD[0]!, { ...TO_BUILD[1]!, edited: true }, ...TO_BUILD.slice(2)],
  ],
] as const)
  check(
    denial(historyOf(writerId, anchors)) === TrustDenial.StateHistoryInvalid,
    `denies ${name}`,
  );
check(
  detail(
    historyOf(AGENT, [INITIALIZED, anchor(AGENT, at(Accept, Waiting))]),
  ) ===
    `Account ${AGENT} cannot move a delivery from requirements:ready to accept:waiting.`,
  "names the move that is not allowed",
);
for (const [name, writerId, anchors] of [
  [
    "a blocked phase retried",
    OPERATOR,
    [
      INITIALIZED,
      anchor(AGENT, at(Requirements, Working)),
      anchor(AGENT, at(Requirements, Blocked)),
      anchor(OPERATOR, at(Requirements, Ready)),
    ],
  ],
  [
    "a closed delivery initialized again",
    OPERATOR,
    [...TO_ACCEPT, anchor(OPERATOR, at(Requirements, Ready))],
  ],
  [
    "an issue the agent anchored first in bootstrap mode, once an approver moved it",
    OPERATOR,
    [
      anchor(AGENT, HERE),
      anchor(AGENT, at(Build, Waiting)),
      anchor(OPERATOR, at(Review, Ready)),
    ],
  ],
  [
    "untrusted anchors between trusted ones",
    AGENT,
    [
      INITIALIZED,
      anchor(APPROVER, at(Accept, Waiting)),
      { ...anchor(AGENT, at(Observe, Ready)), signatureValid: false },
      anchor(AGENT, at(Requirements, Working)),
    ],
  ],
] as const)
  check(historyOf(writerId, anchors).trusted, `trusts ${name}`);
check(
  historyOf(AGENT, [anchor(AGENT)], bootstrap).trusted,
  "bootstrap lets an issue from an earlier AIR start anywhere",
);
check(
  denial(
    historyOf(
      AGENT,
      [anchor(AGENT), anchor(AGENT, at(Accept, Waiting))],
      bootstrap,
    ),
  ) === TrustDenial.StateHistoryInvalid,
  "bootstrap still checks every move after the first anchor",
);

// record
check(
  policy.record({ authorId: AGENT, edited: false, signatureValid: true })
    .trusted,
  "trusts an unedited, validly signed agent record",
);
for (const [name, evidence, expected] of [
  [
    "a signed marker copied by someone else",
    { authorId: APPROVER, edited: false, signatureValid: true },
    TrustDenial.RecordNotByAgent,
  ],
  [
    "a record from the operator",
    { authorId: OPERATOR, edited: false, signatureValid: true },
    TrustDenial.RecordNotByAgent,
  ],
  [
    "an agent record edited later",
    { authorId: AGENT, edited: true, signatureValid: true },
    TrustDenial.RecordEdited,
  ],
  [
    "an agent record with an invalid signature",
    { authorId: AGENT, edited: false, signatureValid: false },
    TrustDenial.RecordSignatureInvalid,
  ],
] as const)
  check(denial(policy.record(evidence)) === expected, `denies ${name}`);

// content
for (const [name, facts, expected] of [
  [
    "an approver",
    { authorId: APPROVER, edited: false },
    ContentTrust.Instruction,
  ],
  ["the agent", { authorId: AGENT, edited: false }, ContentTrust.Air],
  ["the operator", { authorId: OPERATOR, edited: false }, ContentTrust.Air],
  ["anyone else", { authorId: 66, edited: false }, ContentTrust.Data],
  [
    "an edited approver comment",
    { authorId: APPROVER, edited: true },
    ContentTrust.Data,
  ],
  [
    "an edited AIR comment",
    { authorId: AGENT, edited: true },
    ContentTrust.Data,
  ],
] as const)
  check(policy.content(facts).trust === expected, `classifies ${name}`);
check(
  policy.contentAccess(APPROVER, { currentId: APPROVER, canWrite: true })
    .trust === ContentTrust.Instruction,
  "keeps an approver's text as instruction with current access",
);
for (const [name, access] of [
  ["lost write access", { currentId: APPROVER, canWrite: false }],
  ["changed identity", { currentId: 99, canWrite: true }],
] as const)
  check(
    policy.contentAccess(APPROVER, access).trust === ContentTrust.Data,
    `demotes an approver's text to data after ${name}`,
  );

// reply markers
check(
  policy.reply({ authorId: OPERATOR, edited: false }).trusted,
  "trusts an unedited reply marker from the operator",
);
check(
  denial(policy.reply({ authorId: AGENT, edited: false })) ===
    TrustDenial.ReplyNotByOperator,
  "denies a reply marker from anyone else",
);
check(
  denial(policy.reply({ authorId: OPERATOR, edited: true })) ===
    TrustDenial.ReplyEdited,
  "denies an edited reply marker",
);

// anchorCounts
const anchorAt: Position = {
  phase: DeliveryPhase.Build,
  status: DeliveryStatus.Ready,
};
for (const [name, anchor, expected] of [
  ["an operator anchor", { authorId: OPERATOR }, true],
  ["an agent anchor", { authorId: AGENT }, true],
  ["a deployer anchor", { authorId: DEPLOYER }, true],
  ["an approver's anchor", { authorId: APPROVER }, false],
  ["an edited anchor", { authorId: OPERATOR, edited: true }, false],
  ["a bad signature", { authorId: OPERATOR, signatureValid: false }, false],
] as const)
  check(
    policy.anchorCounts({
      edited: false,
      signatureValid: true,
      position: anchorAt,
      ...anchor,
    }) === expected,
    `${expected ? "counts" : "does not count"} ${name}`,
  );

// protected-change approvals (ADR-0017)
for (const [name, evidence, expected] of [
  [
    "the operator's signed approval",
    { authorId: OPERATOR, edited: false, signatureValid: true },
    true,
  ],
  [
    "an approval by the agent",
    { authorId: AGENT, edited: false, signatureValid: true },
    false,
  ],
  [
    "an approval by an approver",
    { authorId: APPROVER, edited: false, signatureValid: true },
    false,
  ],
  [
    "an edited approval",
    { authorId: OPERATOR, edited: true, signatureValid: true },
    false,
  ],
  [
    "an unsigned approval",
    { authorId: OPERATOR, edited: false, signatureValid: false },
    false,
  ],
] as const)
  check(
    new TrustPolicy(roster).approval(evidence).trusted === expected,
    `${expected ? "counts" : "does not count"} ${name}`,
  );

// roster
for (const [name, change] of [
  ["shared service accounts", { agentId: OPERATOR }],
  ["a service approver", { approverIds: [AGENT] }],
  ["the deployer as approver", { approverIds: [DEPLOYER] }],
  ["an operator approver without opt-in", { approverIds: [OPERATOR] }],
] as const)
  throws(() => new TrustPolicy({ ...roster, ...change }), `refuses ${name}`);

console.log("TrustPolicy passed: " + assertions + " assertions");
