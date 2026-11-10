const domainValues = new Set([
  "requirements", "design", "build", "review", "accept", "observe",
  "ready", "working", "blocked", "waiting",
  "human", "agent", "gate", "deployment-workflow",
  "initialize", "start", "complete", "block", "retry", "rework",
  "advance", "deploy-stage", "deploy-prod", "close", "recover",
  "not-authorized", "invalid-transition", "gate-rejected", "precondition-failed",
]);

/** Detect raw delivery vocabulary in control-flow comparisons, not protocol declarations. */
export default {
  meta: {
    type: "suggestion",
    docs: { description: "Use typed delivery constants instead of magic strings in conditions" },
    schema: [],
    messages: {
      magic: "Use a typed Delivery* or DecisionReason constant instead of '{{ value }}'.",
    },
  },
  create(context) {
    function check(node) {
      if (node?.type !== "Literal" || !domainValues.has(node.value)) return;
      context.report({ node, messageId: "magic", data: { value: node.value } });
    }
    return {
      BinaryExpression(node) {
        if (!["==", "===", "!=", "!=="].includes(node.operator)) return;
        check(node.left);
        check(node.right);
      },
      SwitchCase(node) {
        check(node.test);
      },
    };
  },
};
