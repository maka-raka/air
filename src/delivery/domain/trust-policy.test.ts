import { ContentTrust, TrustDenial, TrustPolicy } from "./trust-policy.js";
import type { TrustDecision, TrustRoster } from "./trust-policy.js";

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
for (const writerId of [OPERATOR, AGENT, DEPLOYER])
  check(
    policy.state({ known: true, writerId, writerLogin: "air" }).trusted,
    `trusts state written by service account ${writerId}`,
  );
const byPerson = policy.state({
  known: true,
  writerId: APPROVER,
  writerLogin: "octocat",
});
check(
  denial(byPerson) === TrustDenial.UntrustedStateWriter,
  "denies state written by a person",
);
check(detail(byPerson).includes("octocat"), "names the person");
check(
  detail(policy.state({ known: true, writerId: 0, writerLogin: "" })).includes(
    "deleted account",
  ),
  "names a deleted writer account",
);
const unknown = policy.state({ known: false, reason: "History cut" });
check(
  denial(unknown) === TrustDenial.UnknownStateWriter,
  "denies an unknown writer",
);
check(detail(unknown) === "History cut", "keeps the reason");
check(
  denial(
    new TrustPolicy({ ...roster, deployerId: null }).state({
      known: true,
      writerId: DEPLOYER,
      writerLogin: "x",
    }),
  ) === TrustDenial.UntrustedStateWriter,
  "does not trust a deployer that is not configured",
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

// roster
for (const [name, change] of [
  ["shared service accounts", { agentId: OPERATOR }],
  ["a service approver", { approverIds: [AGENT] }],
  ["the deployer as approver", { approverIds: [DEPLOYER] }],
  ["an operator approver without opt-in", { approverIds: [OPERATOR] }],
] as const)
  throws(() => new TrustPolicy({ ...roster, ...change }), `refuses ${name}`);

console.log("TrustPolicy passed: " + assertions + " assertions");
