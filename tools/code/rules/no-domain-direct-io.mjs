/** Guard against direct infrastructure access in domain modules. */
const forbiddenModules = /^(?:node:)?(?:fs(?:\/.*)?|http(?:\/.*)?|https(?:\/.*)?|net(?:\/.*)?|tls(?:\/.*)?|child_process|process|worker_threads)$/;
const forbiddenGlobals = new Set(["fetch", "setTimeout", "setInterval"]);
const forbiddenObjects = new Set(["process", "console"]);

export default {
  meta: {
    type: "problem",
    docs: { description: "Keep direct I/O out of domain modules" },
    schema: [],
    messages: {
      module: "Domain modules must not import infrastructure module '{{ name }}'.",
      global: "Domain modules must not access side-effecting global '{{ name }}'.",
    },
  },
  create(context) {
    function checkModule(node, source) {
      if (typeof source?.value !== "string") return;
      if (!forbiddenModules.test(source.value)) return;
      context.report({ node, messageId: "module", data: { name: source.value } });
    }
    function checkReference(node) {
      if (node.type === "CallExpression" && node.callee.type === "Identifier" &&
          forbiddenGlobals.has(node.callee.name)) {
        context.report({ node: node.callee, messageId: "global", data: { name: node.callee.name } });
      }
      if (node.type === "MemberExpression" && node.object.type === "Identifier" &&
          forbiddenObjects.has(node.object.name)) {
        context.report({ node: node.object, messageId: "global", data: { name: node.object.name } });
      }
    }
    return {
      ImportDeclaration(node) { checkModule(node, node.source); },
      ExportNamedDeclaration(node) { checkModule(node, node.source); },
      ExportAllDeclaration(node) { checkModule(node, node.source); },
      ImportExpression(node) { checkModule(node, node.source); },
      CallExpression: checkReference,
      MemberExpression: checkReference,
    };
  },
};
