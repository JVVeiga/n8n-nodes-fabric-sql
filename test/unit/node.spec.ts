import type { IExecuteFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { FabricSql } from '../../nodes/FabricSql/FabricSql.node';
import * as connection from '../../nodes/FabricSql/transport/connection';
import { executeContext, recordingPool, rowsResult, testCredentials } from '../helpers/context';

function stubWithPool(pool: ReturnType<typeof recordingPool>['pool']) {
	return vi
		.spyOn(connection, 'withPool')
		.mockImplementation(async (_credentials, fn) => await fn(pool));
}

async function run(ctx: IExecuteFunctions) {
	const node = new FabricSql();

	return await node.execute.call(ctx);
}

describe('description', () => {
	it('declares the credential and points at the connection test', () => {
		const node = new FabricSql();

		expect(node.description.credentials).toEqual([
			{ name: 'fabricSqlApi', required: true, testedBy: 'fabricSqlConnectionTest' },
		]);
	});

	it('registers the table search and the credential test as node methods', () => {
		const node = new FabricSql();

		expect(typeof node.methods.listSearch.searchTables).toBe('function');
		expect(typeof node.methods.credentialTest.fabricSqlConnectionTest).toBe('function');
	});

	it('stays wiring rather than logic', async () => {
		const { readFile } = await import('node:fs/promises');
		const source = await readFile('nodes/FabricSql/FabricSql.node.ts', 'utf8');

		expect(source.split('\n').length).toBeLessThan(100);
		expect(source).not.toMatch(/SELECT|INSERT|UPDATE\s/);
	});
});

describe('execute', () => {
	it('runs the resolved operation for every input item', async () => {
		const { pool, calls } = recordingPool(rowsResult(['n'], [[1]]));
		const spy = stubWithPool(pool);
		const ctx = executeContext({
			parameters: { resource: 'query', operation: 'executeQuery', query: 'SELECT 1 AS n' },
			items: [{ json: {} }, { json: {} }, { json: {} }],
		});

		const output = await run(ctx);

		expect(calls).toHaveLength(3);
		expect(output[0]).toHaveLength(3);
		expect(output[0].map((item) => item.pairedItem)).toEqual([
			[{ item: 0 }],
			[{ item: 1 }],
			[{ item: 2 }],
		]);
		spy.mockRestore();
	});

	it('opens exactly one pool for the whole execution', async () => {
		const { pool } = recordingPool();
		const spy = stubWithPool(pool);
		const ctx = executeContext({
			parameters: { resource: 'query', operation: 'executeQuery', query: 'SELECT 1' },
			items: [{ json: {} }, { json: {} }],
		});

		await run(ctx);

		expect(spy).toHaveBeenCalledOnce();
		spy.mockRestore();
	});

	it('rejects an unsupported resource and operation pair', async () => {
		const ctx = executeContext({
			parameters: { resource: 'query', operation: 'teleport' },
		});

		await expect(run(ctx)).rejects.toThrow(
			'The operation "teleport" is not supported for the resource "query".',
		);
	});

	it('does not open a pool for an unsupported operation', async () => {
		const { pool } = recordingPool();
		const spy = stubWithPool(pool);
		const ctx = executeContext({ parameters: { resource: 'row', operation: 'teleport' } });

		await expect(run(ctx)).rejects.toThrow();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('throws a mapped node error when an item fails', async () => {
		const { pool } = recordingPool();
		const spy = stubWithPool(pool);
		const ctx = executeContext({
			parameters: { resource: 'query', operation: 'executeQuery', query: 'DELETE FROM t' },
		});

		await expect(run(ctx)).rejects.toThrow(/read-only/);
		spy.mockRestore();
	});

	it('emits an error item and keeps going when continueOnFail is set', async () => {
		const { pool } = recordingPool(rowsResult(['n'], [[1]]));
		const spy = stubWithPool(pool);
		const ctx = executeContext({
			parameters: { resource: 'query', operation: 'executeQuery', query: 'DELETE FROM t' },
			items: [{ json: {} }, { json: {} }],
			continueOnFail: true,
		});

		const output = await run(ctx);

		expect(output[0]).toHaveLength(2);
		expect(String(output[0][0].json.error)).toMatch(/read-only/);
		expect(output[0][0].pairedItem).toEqual({ item: 0 });
		expect(output[0][1].pairedItem).toEqual({ item: 1 });
		spy.mockRestore();
	});

	it('never leaks the client secret into an error item', async () => {
		const { pool } = recordingPool();
		const spy = stubWithPool(pool);
		const failing: typeof pool = {
			request: () => {
				throw new Error(`connection refused, PWD=${testCredentials.clientSecret};`);
			},
			close: pool.close,
		};
		const poolSpy = vi
			.spyOn(connection, 'withPool')
			.mockImplementation(async (_credentials, fn) => await fn(failing));
		const ctx = executeContext({
			parameters: { resource: 'query', operation: 'executeQuery', query: 'SELECT 1' },
			continueOnFail: true,
		});

		const output = await run(ctx);

		expect(String(output[0][0].json.error)).not.toContain(testCredentials.clientSecret);
		expect(String(output[0][0].json.error)).toContain('***');
		poolSpy.mockRestore();
		spy.mockRestore();
	});
});
