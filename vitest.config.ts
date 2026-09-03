import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		include: ['test/**/*.spec.ts'],
		coverage: {
			provider: 'v8',
			include: ['nodes/**/*.ts', 'credentials/**/*.ts'],
			exclude: ['nodes/**/descriptions/**', 'nodes/**/*.node.json'],
		},
	},
});
