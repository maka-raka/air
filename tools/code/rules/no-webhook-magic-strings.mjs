/** Require named protocol constants when comparing webhook event/action fields. */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Use named GitHub webhook event/action constants in comparisons",
    },
    schema: [],
    messages: {
      magic: "Use a named GitHub webhook constant instead of '{{ value }}'.",
    },
  },
  create(context) {
    function isWebhookField(node) {
      return (
        node?.type === "MemberExpression" &&
        !node.computed &&
        ["event", "action"].includes(node.property.name) &&
        node.object.type === "Identifier" &&
        node.object.name === "envelope"
      );
    }
    function check(field, value) {
      if (!isWebhookField(field) || value?.type !== "Literal") return;
      if (typeof value.value !== "string") return;
      context.report({
        node: value,
        messageId: "magic",
        data: { value: value.value },
      });
    }
    return {
      BinaryExpression(node) {
        if (!["==", "===", "!=", "!=="].includes(node.operator)) return;
        check(node.left, node.right);
        check(node.right, node.left);
      },
    };
  },
};
