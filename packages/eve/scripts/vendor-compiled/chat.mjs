/**
 * Keep Chat SDK type identity shared with consumer adapters. Copying its class
 * declarations creates distinct private fields, making external adapters and
 * handlers incompatible even when both copies use the same package version.
 */
export default {
  packageName: "chat",
  compiledPath: "chat",
  declaration: 'export * from "chat";\n',
};
