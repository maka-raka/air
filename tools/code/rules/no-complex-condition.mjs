class ConditionComplexity {
  count(node) {
    if (node.type === "LogicalExpression") {
      if (["&&", "||"].includes(node.operator)) {
        return this.count(node.left) + this.count(node.right);
      }
    }
    if (node.type === "UnaryExpression" && node.operator === "!") {
      return this.count(node.argument);
    }
    if (
      [
        "TSAsExpression",
        "TSTypeAssertion",
        "TSNonNullExpression",
        "ParenthesizedExpression",
      ].includes(node.type)
    ) {
      return this.count(node.expression);
    }
    return 1;
  }

  check(node, context) {
    const count = this.count(node.test);
    if (count <= 2) return;
    context.report({
      node: node.test,
      messageId: "tooComplex",
      data: { count },
    });
  }
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Limit if conditions to at most two logical operands",
    },
    schema: [],
    messages: {
      tooComplex:
        "This if condition has {{count}} checks; the maximum is 2. Use focused guard clauses or named predicates.",
    },
  },
  create(context) {
    const complexity = new ConditionComplexity();
    return {
      IfStatement(node) {
        complexity.check(node, context);
      },
    };
  },
};
