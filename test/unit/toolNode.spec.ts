import type { ISupplyDataFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	FabricSqlTool,
	supplyFabricSqlTool,
	toToolName,
} from '../../nodes/FabricSqlTool/FabricSqlTool.node';
import { FABRIC_SQL_TOOL_SCHEMA, buildFabricSqlTool } from '../../nodes/FabricSqlTool/tool';
import type { FabricSqlCredentials, PoolLike } from '../../nodes/FabricSql/types';
import { recordingPool, rowsResult, testCredentials, testNode } from '../helpers/context';

const writeEnabled: FabricSqlCredentials = { ...testCredentials, allowWriteOperations: true };

const schemaRows = rowsResult(
	['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE'],
	[
		['dbo', 'bug_reports', 'id', 'int'],
		['dbo', 'bug_reports', 'severity', 'varchar'],
		['dbo', 'deploys', 'sha', 'varchar'],
	],
);

/** A withPool stand-in that hands the callback a recording pool instead of a connection. */
function fakeWithPool(...results: Parameters<typeof recordingPool>) {
	const { pool, calls } = recordingPool(...results);
	const spy = vi.fn(
		async (_credentials: FabricSqlCredentials, fn: (p: PoolLike) => Promise<unknown>) =>
			await fn(pool),
	);

	return { withPool: spy as unknown as never, calls, spy };
}

function supplyContext(parameters: Record<string, unknown> = {}, name = 'Fabric SQL Tool') {
	const warn = vi.fn();

	return {
		ctx: {
			getNodeParameter: (key: string, _itemIndex: number, fallback?: unknown) =>
				key in parameters ? parameters[key] : fallback,
			getCredentials: async () => ({ ...testCredentials }),
			getNode: () => ({ ...testNode, name }),
			logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
		} as unknown as ISupplyDataFunctions,
		warn,
	};
}

async function callTool(tool: { invoke: (input: unknown) => Promise<unknown> }, sql: string) {
	return String(await tool.invoke({ sql }));
}

describe('description', () => {
	it('is an ai_tool sub-node with no main input', () => {
		const node = new FabricSqlTool();

		expect(node.description.outputs).toEqual([{ type: 'ai_tool' }]);
		expect(node.description.inputs).toEqual([]);
		expect(node.description.name).toBe('fabricSqlTool');
	});

	it('requires the same credential and reuses its connection test', () => {
		const node = new FabricSqlTool();

		expect(node.description.credentials).toEqual([
			{ name: 'fabricSqlApi', required: true, testedBy: 'fabricSqlConnectionTest' },
		]);
		expect(typeof node.methods.credentialTest.fabricSqlConnectionTest).toBe('function');
	});

	it('offers a single required sql argument', () => {
		expect(FABRIC_SQL_TOOL_SCHEMA.required).toEqual(['sql']);
		expect(Object.keys(FABRIC_SQL_TOOL_SCHEMA.properties)).toEqual(['sql']);
	});
});

describe('the main node no longer doubles as a tool', () => {
	it('has usableAsTool removed, so it cannot collide with fabricSqlTool', async () => {
		const { FabricSql } = await import('../../nodes/FabricSql/FabricSql.node');

		expect(new FabricSql().description.usableAsTool).toBeUndefined();
	});
});

describe('buildFabricSqlTool — querying', () => {
	function tool(overrides: Partial<Parameters<typeof buildFabricSqlTool>[0]> = {}) {
		const { withPool, calls } = fakeWithPool(rowsResult(['id'], [[1], [2]]));

		return {
			calls,
			tool: buildFabricSqlTool({
				name: 'fabric',
				description: 'd',
				credentials: testCredentials,
				options: { maxRows: 100, maxChars: 8000 },
				withPool,
				...overrides,
			}),
		};
	}

	it('runs the SQL and returns one compact JSON answer', async () => {
		const { tool: built, calls } = tool();

		const answer = await callTool(built, 'SELECT id FROM dbo.bug_reports');

		expect(calls).toHaveLength(1);
		expect(JSON.parse(answer)).toEqual({
			columns: ['id'],
			rows: [{ id: 1 }, { id: 2 }],
			rowCount: 2,
			truncated: false,
		});
	});

	it('caps rows at the server by injecting TOP', async () => {
		const { tool: built, calls } = tool();

		await callTool(built, 'SELECT id FROM dbo.bug_reports');

		expect(calls[0].sql).toBe('SELECT TOP (100) id FROM dbo.bug_reports');
	});

	it('sends no bound parameters, since the model authors the SQL', async () => {
		const { tool: built, calls } = tool();

		await callTool(built, 'SELECT 1');

		expect(calls[0].parameters).toEqual({});
	});

	it('reports an empty argument without opening a connection', async () => {
		const { withPool, calls } = fakeWithPool();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			withPool,
		});

		expect(await callTool(built, '   ')).toMatch(/No SQL was provided/);
		expect(calls).toHaveLength(0);
	});
});

describe('buildFabricSqlTool — read-only is unconditional', () => {
	function tool(credentials: FabricSqlCredentials) {
		const { withPool, calls } = fakeWithPool();

		return {
			calls,
			tool: buildFabricSqlTool({
				name: 'fabric',
				description: 'd',
				credentials,
				options: { maxRows: 100, maxChars: 8000 },
				withPool,
			}),
		};
	}

	it('refuses a write and never reaches the server', async () => {
		const { tool: built, calls } = tool(testCredentials);

		expect(await callTool(built, 'DELETE FROM dbo.bug_reports')).toMatch(/DELETE is not allowed/);
		expect(calls).toHaveLength(0);
	});

	it('still refuses when the credential allows writes', async () => {
		const { tool: built, calls } = tool(writeEnabled);

		expect(await callTool(built, 'DROP TABLE dbo.bug_reports')).toMatch(/DROP is not allowed/);
		expect(calls).toHaveLength(0);
	});

	it('refuses a write hidden after a legitimate read', async () => {
		const { tool: built, calls } = tool(writeEnabled);

		expect(await callTool(built, 'SELECT 1; UPDATE dbo.bug_reports SET severity = 1')).toMatch(
			/UPDATE is not allowed/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe('buildFabricSqlTool — failures come back as text', () => {
	it('returns a mapped message instead of throwing', async () => {
		const failing = vi.fn(async () => {
			throw new Error('Invalid object name @dbo.nope@.');
		});
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			withPool: failing as unknown as never,
		});

		const answer = await callTool(built, 'SELECT * FROM dbo.nope');

		expect(answer).toMatch(/^Query failed: /);
		expect(answer).toContain('Invalid object name');
	});

	it('never leaks the client secret to the model', async () => {
		const failing = vi.fn(async () => {
			throw new Error(`refused PWD=${testCredentials.clientSecret};`);
		});
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			withPool: failing as unknown as never,
		});

		const answer = await callTool(built, 'SELECT 1');

		expect(answer).not.toContain(testCredentials.clientSecret);
		expect(answer).toContain('***');
	});
});

describe('supplyFabricSqlTool', () => {
	it('appends the schema digest to the tool description', async () => {
		const { withPool } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'Bug data.', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { withPool }, 0);
		const tool = supplied.response as { description: string };

		expect(tool.description).toContain('Bug data.');
		expect(tool.description).toContain('dbo.bug_reports(id int, severity varchar)');
		expect(tool.description).toContain('dbo.deploys(sha varchar)');
	});

	it('filters the schema by the LIKE pattern, bound as a parameter', async () => {
		const { withPool, calls } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext({
			toolDescription: 'd',
			includeSchema: true,
			tableFilter: 'bug_%',
		});

		await supplyFabricSqlTool(ctx, { withPool }, 0);

		expect(calls[0].sql).toContain('AND TABLE_NAME LIKE @pattern');
		expect(calls[0].parameters).toEqual({ pattern: 'bug_%' });
	});

	it('tells the model the list is partial when a filter is set', async () => {
		// The filter is applied when the description is built, before any model turn, so the
		// model cannot ask about it — it has to be told, or it treats the subset as everything.
		const { withPool } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext({
			toolDescription: 'Bug data.',
			includeSchema: true,
			tableFilter: 'bug_%',
		});

		const supplied = await supplyFabricSqlTool(ctx, { withPool }, 0);
		const description = (supplied.response as { description: string }).description;

		expect(description).toContain('only tables matching "bug_%" are listed');
		expect(description).toContain('INFORMATION_SCHEMA.TABLES');
	});

	it('claims no partiality when no filter is set', async () => {
		const { withPool } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'Bug data.', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { withPool }, 0);

		expect((supplied.response as { description: string }).description).not.toMatch(/partial list/);
	});

	it('excludes system schemas', async () => {
		const { withPool, calls } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: true });

		await supplyFabricSqlTool(ctx, { withPool }, 0);

		expect(calls[0].sql).toContain("TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')");
	});

	it('reads no schema when the option is off', async () => {
		const { withPool, calls } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'Just this.', includeSchema: false });

		const supplied = await supplyFabricSqlTool(ctx, { withPool }, 0);

		expect(calls).toHaveLength(0);
		expect((supplied.response as { description: string }).description).toBe('Just this.');
	});

	it('still supplies a working tool when the schema read fails', async () => {
		const failing = vi.fn(async () => {
			throw new Error('metadata query timed out');
		});
		const { ctx, warn } = supplyContext({ toolDescription: 'Bug data.', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { withPool: failing as unknown as never }, 0);

		expect((supplied.response as { description: string }).description).toBe('Bug data.');
		expect(warn).toHaveBeenCalledOnce();
	});

	it('names the tool after the node, so a renamed node stays callable', async () => {
		const { withPool } = fakeWithPool(schemaRows);
		const { ctx } = supplyContext(
			{ toolDescription: 'd', includeSchema: false },
			'Fabric SQL Tool (bugs)',
		);

		const supplied = await supplyFabricSqlTool(ctx, { withPool }, 0);

		expect((supplied.response as { name: string }).name).toBe('fabric_sql_tool_bugs');
	});

	it('applies the configured caps', async () => {
		const { withPool, calls } = fakeWithPool(schemaRows, rowsResult(['id'], [[1], [2], [3]]));
		const { ctx } = supplyContext({
			toolDescription: 'd',
			includeSchema: false,
			options: { maxRows: 2, maxChars: 900 },
		});

		const supplied = await supplyFabricSqlTool(ctx, { withPool }, 0);
		const answer = await callTool(
			supplied.response as { invoke: (input: unknown) => Promise<unknown> },
			'SELECT id FROM t',
		);

		expect(calls[0].sql).toBe('SELECT TOP (2) id FROM t');
		expect(JSON.parse(answer).rowCount).toBe(2);
		expect(JSON.parse(answer).truncated).toBe(true);
	});
});

describe('toToolName', () => {
	it('slugifies the node name', () => {
		expect(toToolName('Fabric SQL Tool')).toBe('fabric_sql_tool');
	});

	it('collapses punctuation and trims separators', () => {
		expect(toToolName('  Bugs — lakehouse!! ')).toBe('bugs_lakehouse');
	});

	it('falls back when the name has nothing usable', () => {
		expect(toToolName('!!!')).toBe('fabric_sql');
	});
});
