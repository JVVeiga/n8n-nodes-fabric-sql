import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...(Array.isArray(configWithoutCloudSupport)
		? configWithoutCloudSupport
		: [configWithoutCloudSupport]),
	{
		ignores: ['dist/**', 'coverage/**', 'test/**'],
	},
];
