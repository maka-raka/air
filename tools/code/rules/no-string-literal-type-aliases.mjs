/** Require const-object-derived named string domains instead of string literal type aliases. */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Derive string domain types from an as const object",
    },
    schema: [],
    messages: {
      constObject:
        "Define named string values in an 'as const' object and derive the type with '(typeof Values)[keyof typeof Values]' instead of a string literal type.",
    },
  },
  create(context) {
    function isStringLiteral(node) {
      return (
        node?.type === "TSLiteralType" &&
        typeof node.literal?.value === "string"
      );
    }

    return {
      TSTypeAliasDeclaration(node) {
        const annotation = node.typeAnnotation;
        const types =
          annotation.type === "TSUnionType" ? annotation.types : [annotation];
        if (!types.some(isStringLiteral)) return;
        context.report({ node: annotation, messageId: "constObject" });
      },
    };
  },
};
