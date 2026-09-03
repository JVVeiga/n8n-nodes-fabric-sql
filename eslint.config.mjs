import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

/**
 * Cloud support is off (see package.json "n8n".strict) because n8n Cloud does not allow
 * community nodes with runtime dependencies, and there is no way to speak the TDS protocol
 * without a driver. This node targets self-hosted n8n.
 *
 * `no-runtime-dependencies` is disabled for the same reason: `mssql` and `@azure/identity`
 * are the point of the package, not an oversight. Bundling them is not a real alternative —
 * `tedious` resolves parts of itself dynamically at runtime.
 */
export default [
	...(Array.isArray(configWithoutCloudSupport)
		? configWithoutCloudSupport
		: [configWithoutCloudSupport]),
	{
		rules: {
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
		},
	},
];
