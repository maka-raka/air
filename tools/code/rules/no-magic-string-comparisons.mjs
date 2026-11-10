/**
 * Forbid comparing against inline string literals in production code.
 * Protocol and domain vocabulary must come from named constants.
 * Allowed: the empty string (an emptiness check) and `typeof x === "..."`.
 */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Compare against named constants instead of inline string literals",
    },
    schema: [],
    messages: {
      magic:
        "Use a named constant instead of the string literal '{{ value }}'.",
    },
  },
  create(context) {
    const isTypeof = (node) =>
      node?.type === "UnaryExpression" && node.operator === "typeof";
    function check(literal, other) {
      if (literal?.type !== "Literal" || typeof literal.value !== "string")
        return;
      if (literal.value === "" || isTypeof(other)) return;
      context.report({
        node: literal,
        messageId: "magic",
        data: { value: literal.value },
      });
    }
    return {
      BinaryExpression(node) {
        if (!["==", "===", "!=", "!=="].includes(node.operator)) return;
        check(node.left, node.right);
        check(node.right, node.left);
      },
      SwitchCase(node) {
        check(node.test, null);
      },
    };
  },
};
