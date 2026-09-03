import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

/**
 * Cloud support is off (see package.json "n8n".strict) because n8n Cloud does not allow
 * community nodes with runtime dependencies, and there is no way to speak the TDS protocol
 * without a driver. This node targets self-hosted n8n.
 */
export default [
	...(Array.isArray(configWithoutCloudSupport)
		? configWithoutCloudSupport
		: [configWithoutCloudSupport]),
	{
		rules: {
			// `mssql` and `@azure/identity` are the point of the package, not an oversight.
			// Bundling them is not a real alternative — `tedious` resolves parts of itself
			// dynamically at runtime.
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
			// A tool sub-node has to hand the Agent a `DynamicStructuredTool` built from the
			// SAME `@langchain/core` the host loaded, so `@langchain/core` and its `zod` must be
			// peers. Moving them to `dependencies` installs a second copy and the Agent's
			// instance checks stop matching the tool it was given.
			'@n8n/community-nodes/valid-peer-dependencies': 'off',
		},
	},
	{
		files: ['nodes/FabricSql/FabricSql.node.ts', 'nodes/FabricSqlTool/FabricSqlTool.node.ts'],
		rules: {
			// `usableAsTool` is deliberately absent: n8n synthesizes a `<node>Tool` type from it,
			// which would collide with the dedicated `fabricSqlTool` sub-node. The tool path is
			// that node, which also supplies the schema up front. And a tool sub-node cannot be
			// `usableAsTool` itself — it already IS the tool; the rule does not model sub-nodes.
			'@n8n/community-nodes/node-usable-as-tool': 'off',
		},
	},
];
