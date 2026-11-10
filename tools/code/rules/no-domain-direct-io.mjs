/** Guard against direct infrastructure access in domain modules. */
const forbiddenModules = new Set([
  "fs",
  "http",
  "https",
  "net",
  "tls",
  "child_process",
  "process",
  "worker_threads",
]);
const forbiddenModulePath = /^(?:node:)?([^/]+)(?:\/.*)?$/;
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
      const match = forbiddenModulePath.exec(source.value);
      if (!match) return;
      if (!forbiddenModules.has(match[1])) return;
      context.report({
        node,
        messageId: "module",
        data: { name: source.value },
      });
    }
    function isForbiddenCall(node) {
      if (node.type !== "CallExpression") return false;
      if (node.callee.type !== "Identifier") return false;
      return forbiddenGlobals.has(node.callee.name);
    }
    function isForbiddenMember(node) {
      if (node.type !== "MemberExpression") return false;
      if (node.object.type !== "Identifier") return false;
      return forbiddenObjects.has(node.object.name);
    }
    function checkReference(node) {
      if (isForbiddenCall(node)) {
        context.report({
          node: node.callee,
          messageId: "global",
          data: { name: node.callee.name },
        });
      }
      if (isForbiddenMember(node)) {
        context.report({
          node: node.object,
          messageId: "global",
          data: { name: node.object.name },
        });
      }
    }
    return {
      ImportDeclaration(node) {
        checkModule(node, node.source);
      },
      ExportNamedDeclaration(node) {
        checkModule(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkModule(node, node.source);
      },
      ImportExpression(node) {
        checkModule(node, node.source);
      },
      CallExpression: checkReference,
      MemberExpression: checkReference,
    };
  },
};
