import type { ISupplyDataFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	FabricSqlTool,
	supplyFabricSqlTool,
	toToolName,
} from '../../nodes/FabricSqlTool/FabricSqlTool.node';
import {
	FABRIC_SQL_TOOL_SCHEMA,
	QUERY_CACHE_LIMIT,
	buildFabricSqlTool,
} from '../../nodes/FabricSqlTool/tool';
import { QUERY_COST_GUIDANCE } from '../../nodes/FabricSql/core/toolOutput';
import type { ToolRunLog } from '../../nodes/FabricSqlTool/toolRunLog';
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

/** A pool that opens fine but whose every query throws. */
function failingPool(onQuery: () => Promise<never>): PoolLike {
	return {
		request: () => ({
			arrayRowMode: undefined,
			input() {
				return this;
			},
			query: onQuery,
		}),
		close: vi.fn(async () => undefined),
	};
}

/** A shared, already-open pool, plus an openPool spy so reuse can be counted. */
function fakePool(...results: Parameters<typeof recordingPool>) {
	const { pool, calls } = recordingPool(...results);
	const openPool = vi.fn(async () => pool);

	return { pool, calls, openPool };
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
		const { pool, calls } = fakePool(rowsResult(['id'], [[1], [2]]));

		return {
			calls,
			tool: buildFabricSqlTool({
				name: 'fabric',
				description: 'd',
				credentials: testCredentials,
				options: { maxRows: 100, maxChars: 8000 },
				pool,
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
		const { pool, calls } = fakePool();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			pool,
		});

		expect(await callTool(built, '   ')).toMatch(/No SQL was provided/);
		expect(calls).toHaveLength(0);
	});
});

describe('buildFabricSqlTool — read-only is unconditional', () => {
	function tool(credentials: FabricSqlCredentials) {
		const { pool, calls } = fakePool();

		return {
			calls,
			tool: buildFabricSqlTool({
				name: 'fabric',
				description: 'd',
				credentials,
				options: { maxRows: 100, maxChars: 8000 },
				pool,
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
			pool: failingPool(failing),
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
			pool: failingPool(failing),
		});

		const answer = await callTool(built, 'SELECT 1');

		expect(answer).not.toContain(testCredentials.clientSecret);
		expect(answer).toContain('***');
	});
});

describe('supplyFabricSqlTool', () => {
	it('appends the schema digest to the tool description', async () => {
		const { openPool } = fakePool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'Bug data.', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);
		const tool = supplied.response as { description: string };

		expect(tool.description).toContain('Bug data.');
		expect(tool.description).toContain('dbo.bug_reports(id int, severity varchar)');
		expect(tool.description).toContain('dbo.deploys(sha varchar)');
	});

	it('filters the schema by the LIKE pattern, bound as a parameter', async () => {
		const { openPool, calls } = fakePool(schemaRows);
		const { ctx } = supplyContext({
			toolDescription: 'd',
			includeSchema: true,
			tableFilter: 'bug_%',
		});

		await supplyFabricSqlTool(ctx, { openPool }, 0);

		expect(calls[0].sql).toContain('AND TABLE_NAME LIKE @pattern');
		expect(calls[0].parameters).toEqual({ pattern: 'bug_%' });
	});

	it('tells the model the list is partial when a filter is set', async () => {
		// The filter is applied when the description is built, before any model turn, so the
		// model cannot ask about it — it has to be told, or it treats the subset as everything.
		const { openPool } = fakePool(schemaRows);
		const { ctx } = supplyContext({
			toolDescription: 'Bug data.',
			includeSchema: true,
			tableFilter: 'bug_%',
		});

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);
		const description = (supplied.response as { description: string }).description;

		expect(description).toContain('only tables matching "bug_%" are listed');
		expect(description).toContain('INFORMATION_SCHEMA.TABLES');
	});

	it('claims no partiality when no filter is set', async () => {
		const { openPool } = fakePool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'Bug data.', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);

		expect((supplied.response as { description: string }).description).not.toMatch(/partial list/);
	});

	it('excludes system schemas', async () => {
		const { openPool, calls } = fakePool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: true });

		await supplyFabricSqlTool(ctx, { openPool }, 0);

		expect(calls[0].sql).toContain("TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')");
	});

	it('reads no schema when the option is off', async () => {
		const { openPool, calls } = fakePool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'Just this.', includeSchema: false });

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);

		expect(calls).toHaveLength(0);
		const description = (supplied.response as { description: string }).description;

		expect(description).toContain('Just this.');
		expect(description).not.toContain('Available tables');
	});

	it('still supplies a working tool when the schema read fails', async () => {
		const failing = vi.fn(async () => {
			throw new Error('metadata query timed out');
		});
		const { ctx, warn } = supplyContext({ toolDescription: 'Bug data.', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { openPool: async () => failingPool(failing) }, 0);

		const description = (supplied.response as { description: string }).description;

		expect(description).toContain('Bug data.');
		expect(description).not.toContain('Available tables');
		expect(warn).toHaveBeenCalledOnce();
	});

	it('names the tool after the node, so a renamed node stays callable', async () => {
		const { openPool } = fakePool(schemaRows);
		const { ctx } = supplyContext(
			{ toolDescription: 'd', includeSchema: false },
			'Fabric SQL Tool (bugs)',
		);

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);

		expect((supplied.response as { name: string }).name).toBe('fabric_sql_tool_bugs');
	});

	it('applies the configured caps', async () => {
		const { openPool, calls } = fakePool(schemaRows, rowsResult(['id'], [[1], [2], [3]]));
		const { ctx } = supplyContext({
			toolDescription: 'd',
			includeSchema: false,
			options: { maxRows: 2, maxChars: 900 },
		});

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);
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

function fakeLog() {
	const started: Array<Record<string, unknown>> = [];
	const ended: Array<Record<string, unknown>> = [];
	const errored: unknown[] = [];
	const log: ToolRunLog = {
		start: (payload) => {
			started.push(payload);
			return started.length - 1;
		},
		end: (_index, payload) => {
			ended.push(payload);
		},
		error: (_index, error) => {
			errored.push(error);
		},
	};

	return { log, started, ended, errored };
}

describe('canvas visibility', () => {
	it('registers the call and the result, so the node does not look untouched', async () => {
		// Without this the tool answers the agent correctly and leaves no trace in the
		// execution — which is most of what you need when an agent reaches a wrong conclusion.
		const { pool } = fakePool(rowsResult(['id'], [[1]]));
		const { log, started, ended } = fakeLog();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 10, maxChars: 8000 },
			pool,
			log,
		});

		await callTool(built, 'SELECT id FROM t');

		expect(started).toEqual([{ sql: 'SELECT id FROM t' }]);
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({ rowCount: 1, truncated: false });
	});

	it('logs the SQL actually executed, not the SQL asked for', async () => {
		const { pool } = fakePool(rowsResult(['id'], [[1]]));
		const { log, ended } = fakeLog();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 10, maxChars: 8000 },
			pool,
			log,
		});

		await callTool(built, 'SELECT id FROM t');

		expect(ended[0].executedSql).toBe('SELECT TOP (10) id FROM t');
	});

	it('closes a failed call as failed rather than leaving it open', async () => {
		const failing = vi.fn(async () => {
			throw Object.assign(new Error('nope'), { code: 'ESOCKET' });
		});
		const { log, started, errored } = fakeLog();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 10, maxChars: 8000 },
			pool: failingPool(failing),
			log,
		});

		const answer = await callTool(built, 'SELECT 1');

		expect(started).toHaveLength(1);
		expect(errored).toHaveLength(1);
		// The model still gets text — a failed lookup is not a reason to kill the run.
		expect(answer).toMatch(/^Query failed: /);
	});

	it('still registers a call the guard rejects', async () => {
		const { pool } = fakePool();
		const { log, started, ended } = fakeLog();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 10, maxChars: 8000 },
			pool,
			log,
		});

		await callTool(built, 'DELETE FROM t');

		expect(started).toHaveLength(1);
		expect(String(ended[0].response)).toMatch(/DELETE is not allowed/);
	});

	it('works with no logger at all', async () => {
		const { pool } = fakePool(rowsResult(['id'], [[1]]));
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 10, maxChars: 8000 },
			pool,
		});

		expect(JSON.parse(await callTool(built, 'SELECT id FROM t')).rowCount).toBe(1);
	});
});

describe('one connection per execution', () => {
	it('opens the pool once and reuses it for the schema read and every call', async () => {
		// The whole point: a per-call pool made every question the model asked pay a TCP
		// connect, a TLS handshake and an Entra ID token exchange.
		const { openPool, calls } = fakePool(schemaRows, rowsResult(['id'], [[1]]));
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: true });

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);
		const tool = supplied.response as { invoke: (input: unknown) => Promise<unknown> };

		await callTool(tool, 'SELECT id FROM a');
		await callTool(tool, 'SELECT id FROM b');
		await callTool(tool, 'SELECT id FROM c');

		expect(openPool).toHaveBeenCalledOnce();
		// One schema read plus three distinct queries, all on the same pool.
		expect(calls).toHaveLength(4);
	});

	it('closes the pool when the execution ends', async () => {
		const { openPool, pool } = fakePool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: false });

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);

		expect(pool.close).not.toHaveBeenCalled();
		await supplied.closeFunction?.();
		expect(pool.close).toHaveBeenCalledOnce();
	});

	it('fails loudly when the pool cannot be opened at all', async () => {
		// Unlike a failed schema read, this is fatal: a tool that cannot connect has nothing to
		// offer, and saying so now beats failing on the agent's first question.
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: true });
		const openPool = async () => {
			throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
		};

		await expect(supplyFabricSqlTool(ctx, { openPool }, 0)).rejects.toThrow(/Could not reach/);
	});
});

describe('repeated questions', () => {
	async function toolWith(...results: Parameters<typeof recordingPool>) {
		const { openPool, calls } = fakePool(...results);
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: false });
		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);

		return {
			calls,
			tool: supplied.response as { invoke: (input: unknown) => Promise<unknown> },
		};
	}

	it('answers an identical query from memory instead of asking again', async () => {
		const { tool, calls } = await toolWith(rowsResult(['id'], [[1]]));

		const first = await callTool(tool, 'SELECT id FROM t');
		const second = await callTool(tool, 'SELECT id FROM t');

		expect(second).toBe(first);
		expect(calls).toHaveLength(1);
	});

	it('treats a differently written query as a different question', async () => {
		const { tool, calls } = await toolWith(rowsResult(['id'], [[1]]));

		await callTool(tool, 'SELECT id FROM t');
		await callTool(tool, 'SELECT id FROM u');

		expect(calls).toHaveLength(2);
	});

	it('caches on the executed SQL, so two spellings of one query share an answer', async () => {
		const { tool, calls } = await toolWith(rowsResult(['id'], [[1]]));

		// Both become `SELECT TOP (100) id FROM t` once the row cap is applied.
		await callTool(tool, 'SELECT id FROM t');
		await callTool(tool, '  SELECT id FROM t  ');

		expect(calls).toHaveLength(1);
	});

	it('still registers a cached call, so the canvas matches the transcript', async () => {
		const { pool } = fakePool(rowsResult(['id'], [[1]]));
		const { log, started, ended } = fakeLog();
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			pool,
			log,
		});

		await callTool(built, 'SELECT id FROM t');
		await callTool(built, 'SELECT id FROM t');

		expect(started).toHaveLength(2);
		expect(ended).toHaveLength(2);
		expect(ended[0].cached).toBe(false);
		expect(ended[1].cached).toBe(true);
	});

	it('does not cache a failure, which is transient', async () => {
		let attempts = 0;
		const pool = failingPool(async () => {
			attempts += 1;
			throw Object.assign(new Error('timed out'), { code: 'ETIMEOUT' });
		});
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			pool,
		});

		await callTool(built, 'SELECT 1');
		await callTool(built, 'SELECT 1');

		expect(attempts).toBe(2);
	});

	it('evicts the oldest answer once the cache is full', async () => {
		const { pool, calls } = fakePool(rowsResult(['id'], [[1]]));
		const built = buildFabricSqlTool({
			name: 'fabric',
			description: 'd',
			credentials: testCredentials,
			options: { maxRows: 100, maxChars: 8000 },
			pool,
		});

		for (let i = 0; i < QUERY_CACHE_LIMIT + 1; i += 1) {
			await callTool(built, `SELECT ${i} AS n`);
		}
		const before = calls.length;
		// The very first query has been evicted, so it costs a round trip again.
		await callTool(built, 'SELECT 0 AS n');

		expect(calls.length).toBe(before + 1);
	});
});

describe('query cost guidance', () => {
	it('is always part of what the model reads', async () => {
		const { openPool } = fakePool(schemaRows);
		const { ctx } = supplyContext({ toolDescription: 'd', includeSchema: false });

		const supplied = await supplyFabricSqlTool(ctx, { openPool }, 0);
		const description = (supplied.response as { description: string }).description;

		expect(description).toContain(QUERY_COST_GUIDANCE);
	});

	it('tells the model not to use SELECT *, which the row cap cannot limit', () => {
		expect(QUERY_COST_GUIDANCE).toContain('SELECT *');
		expect(QUERY_COST_GUIDANCE).toContain('no indexes');
	});

	it('says the same in the sql argument description, where the model reads it again', () => {
		expect(FABRIC_SQL_TOOL_SCHEMA.properties.sql.description).toContain('Name the columns');
	});
});
