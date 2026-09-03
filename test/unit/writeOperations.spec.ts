import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { ReadOnlySqlError } from '../../nodes/FabricSql/core/errors';
import { MSSQL_PARAMETER_LIMIT } from '../../nodes/FabricSql/core/queryBuilder';
import { deleteRows } from '../../nodes/FabricSql/operations/deleteRows';
import { insertRows } from '../../nodes/FabricSql/operations/insertRows';
import { operations, resolveOperation } from '../../nodes/FabricSql/operations';
import { runOperation } from '../../nodes/FabricSql/operations/run';
import { updateRows } from '../../nodes/FabricSql/operations/updateRows';
import { executeContext, recordingPool, testCredentials } from '../helpers/context';

const writeEnabled = { ...testCredentials, allowWriteOperations: true };

function affected(count: number) {
	return { recordsets: [], rowsAffected: [count], columns: [] };
}

function itemsOf(...rows: IDataObject[]): INodeExecutionData[] {
	return rows.map((json) => ({ json }));
}

describe('registry', () => {
	it('registers the write operations with the right feeding strategy', () => {
		expect(resolveOperation('row', 'insert')?.kind).toBe('batch');
		expect(resolveOperation('row', 'delete')?.kind).toBe('batch');
		expect(resolveOperation('row', 'update')?.kind).toBe('item');
	});

	it('covers every resource and operation pair offered in the UI', () => {
		expect(Object.keys(operations).sort()).toEqual([
			'query:executeQuery',
			'row:delete',
			'row:insert',
			'row:select',
			'row:update',
			'schema:describeTable',
			'schema:listTables',
		]);
	});
});

describe('insertRows', () => {
	const params = {
		table: { mode: 'list', value: 'dbo.t' },
		columns: 'id, name',
	};

	it('refuses to run when the credential does not allow writes', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: params });

		await expect(
			insertRows(ctx, pool, testCredentials, itemsOf({ id: 1, name: 'a' })),
		).rejects.toThrow(ReadOnlySqlError);
		expect(calls).toHaveLength(0);
	});

	it('packs every item into one statement with bound values', async () => {
		const { pool, calls } = recordingPool(affected(2));
		const ctx = executeContext({ parameters: params });

		const output = await insertRows(
			ctx,
			pool,
			writeEnabled,
			itemsOf({ id: 1, name: 'a' }, { id: 2, name: 'b' }),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toBe(
			'INSERT INTO [dbo].[t] ([id], [name]) VALUES (@r0c0, @r0c1), (@r1c0, @r1c1)',
		);
		expect(calls[0].parameters).toEqual({ r0c0: 1, r0c1: 'a', r1c0: 2, r1c1: 'b' });
		expect(output[0].json).toEqual({
			operation: 'insert',
			table: 'dbo.t',
			rows: 2,
			rowsAffected: 2,
		});
	});

	it('pairs the summary with every input item', async () => {
		const { pool } = recordingPool(affected(2));
		const ctx = executeContext({ parameters: params });

		const output = await insertRows(ctx, pool, writeEnabled, itemsOf({ id: 1 }, { id: 2 }));

		expect(output[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('binds null for a column missing from an item', async () => {
		const { pool, calls } = recordingPool(affected(1));
		const ctx = executeContext({ parameters: params });

		await insertRows(ctx, pool, writeEnabled, itemsOf({ id: 1 }));

		expect(calls[0].parameters).toEqual({ r0c0: 1, r0c1: null });
	});

	it('splits a large batch across statements and sums the rows affected', async () => {
		const { pool, calls } = recordingPool(affected(1050), affected(450));
		const ctx = executeContext({ parameters: params });
		const items = itemsOf(
			...Array.from({ length: 1500 }, (_unused, index) => ({ id: index, name: 'x' })),
		);

		const output = await insertRows(ctx, pool, writeEnabled, items);

		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(Object.keys(call.parameters).length).toBeLessThanOrEqual(MSSQL_PARAMETER_LIMIT);
		}
		expect(output[0].json.rowsAffected).toBe(1500);
	});
});

describe('updateRows', () => {
	const params = {
		table: { mode: 'list', value: 'dbo.t' },
		columns: 'name, status',
		matchColumn: 'id',
	};

	it('refuses to run when the credential does not allow writes', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({ parameters: params, items: itemsOf({ id: 1 }) });

		await expect(updateRows(ctx, pool, testCredentials, 0)).rejects.toThrow(ReadOnlySqlError);
	});

	it('binds the set values and the match value from the item', async () => {
		const { pool, calls } = recordingPool(affected(1));
		const ctx = executeContext({
			parameters: params,
			items: itemsOf({ id: 7, name: 'a', status: 'ok' }),
		});

		const output = await updateRows(ctx, pool, writeEnabled, 0);

		expect(calls[0].sql).toBe(
			'UPDATE [dbo].[t] SET [name] = @s0, [status] = @s1 WHERE [id] = @match',
		);
		expect(calls[0].parameters).toEqual({ match: 7, s0: 'a', s1: 'ok' });
		expect(output[0].json).toEqual({
			operation: 'update',
			table: 'dbo.t',
			matchColumn: 'id',
			rowsAffected: 1,
		});
	});

	it('updates only the item at the given index', async () => {
		const { pool, calls } = recordingPool(affected(1));
		const ctx = executeContext({
			parameters: params,
			items: itemsOf({ id: 1, name: 'a' }, { id: 2, name: 'b' }),
		});

		await updateRows(ctx, pool, writeEnabled, 1);

		expect(calls[0].parameters.match).toBe(2);
		expect(calls[0].parameters.s0).toBe('b');
	});
});

describe('deleteRows', () => {
	const params = { table: { mode: 'list', value: 'dbo.t' }, matchColumn: 'id' };

	it('refuses to run when the credential does not allow writes', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: params });

		await expect(deleteRows(ctx, pool, testCredentials, itemsOf({ id: 1 }))).rejects.toThrow(
			ReadOnlySqlError,
		);
		expect(calls).toHaveLength(0);
	});

	it('collects the match values into one IN list', async () => {
		const { pool, calls } = recordingPool(affected(3));
		const ctx = executeContext({ parameters: params });

		const output = await deleteRows(
			ctx,
			pool,
			writeEnabled,
			itemsOf({ id: 1 }, { id: 2 }, { id: 3 }),
		);

		expect(calls[0].sql).toBe('DELETE FROM [dbo].[t] WHERE [id] IN (@m0, @m1, @m2)');
		expect(calls[0].parameters).toEqual({ m0: 1, m1: 2, m2: 3 });
		expect(output[0].json).toMatchObject({ matched: 3, skipped: 0, rowsAffected: 3 });
	});

	it('skips an item with no value for the match column rather than matching NULL', async () => {
		const { pool, calls } = recordingPool(affected(1));
		const ctx = executeContext({ parameters: params });

		const output = await deleteRows(ctx, pool, writeEnabled, itemsOf({ id: 1 }, { name: 'x' }));

		expect(calls[0].parameters).toEqual({ m0: 1 });
		expect(output[0].json).toMatchObject({ matched: 1, skipped: 1 });
	});

	it('runs no statement when nothing has a match value', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: params });

		const output = await deleteRows(ctx, pool, writeEnabled, itemsOf({ name: 'x' }));

		expect(calls).toHaveLength(0);
		expect(output[0].json).toMatchObject({ matched: 0, skipped: 1, rowsAffected: 0 });
	});

	it('chunks a long IN list', async () => {
		const { pool, calls } = recordingPool(affected(2100), affected(1));
		const ctx = executeContext({ parameters: params });
		const items = itemsOf(
			...Array.from({ length: MSSQL_PARAMETER_LIMIT + 1 }, (_unused, id) => ({ id })),
		);

		const output = await deleteRows(ctx, pool, writeEnabled, items);

		expect(calls).toHaveLength(2);
		expect(output[0].json.rowsAffected).toBe(2101);
	});
});

describe('runOperation', () => {
	it('hands every item to a batch operation at once', async () => {
		const { pool, calls } = recordingPool(affected(2));
		const ctx = executeContext({
			parameters: { table: { mode: 'list', value: 't' }, columns: 'id' },
			items: itemsOf({ id: 1 }, { id: 2 }),
		});

		const output = await runOperation(
			ctx,
			pool,
			writeEnabled,
			{ kind: 'batch', run: insertRows },
			ctx.getInputData(),
		);

		expect(calls).toHaveLength(1);
		expect(output).toHaveLength(1);
	});

	it('attributes a batch failure to every item when continuing on fail', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({
			parameters: { table: { mode: 'list', value: 't' }, columns: 'id' },
			items: itemsOf({ id: 1 }, { id: 2 }),
			continueOnFail: true,
		});

		const output = await runOperation(
			ctx,
			pool,
			testCredentials,
			{ kind: 'batch', run: insertRows },
			ctx.getInputData(),
		);

		expect(output).toHaveLength(1);
		expect(String(output[0].json.error)).toMatch(/read-only/);
		expect(output[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('throws a mapped node error from a batch operation when not continuing', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({
			parameters: { table: { mode: 'list', value: 't' }, columns: 'id' },
			items: itemsOf({ id: 1 }),
		});

		await expect(
			runOperation(
				ctx,
				pool,
				testCredentials,
				{ kind: 'batch', run: insertRows },
				ctx.getInputData(),
			),
		).rejects.toThrow(/read-only/);
	});
});
