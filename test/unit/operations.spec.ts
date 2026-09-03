import { describe, expect, it } from 'vitest';

import { EmptySqlError, ReadOnlySqlError } from '../../nodes/FabricSql/core/errors';
import { executeQuery } from '../../nodes/FabricSql/operations/executeQuery';
import { operations, resolveOperation } from '../../nodes/FabricSql/operations';
import { selectRows } from '../../nodes/FabricSql/operations/selectRows';
import { executeContext, recordingPool, rowsResult, testCredentials } from '../helpers/context';

const writeEnabled = { ...testCredentials, allowWriteOperations: true };

describe('registry', () => {
	it('exposes the read operations', () => {
		expect(Object.keys(operations)).toEqual(
			expect.arrayContaining(['query:executeQuery', 'row:select']),
		);
	});

	it('resolves a known resource and operation', () => {
		expect(resolveOperation('query', 'executeQuery')).toEqual({
			kind: 'item',
			run: executeQuery,
		});
	});

	it('returns undefined for an unknown pair', () => {
		expect(resolveOperation('query', 'nope')).toBeUndefined();
	});
});

describe('executeQuery', () => {
	it('runs the query and maps the rows', async () => {
		const { pool, calls } = recordingPool(rowsResult(['id', 'name'], [[1, 'a']]));
		const ctx = executeContext({ parameters: { query: 'SELECT id, name FROM t' } });

		const items = await executeQuery(ctx, pool, testCredentials, 0);

		expect(calls).toEqual([{ sql: 'SELECT id, name FROM t', parameters: {} }]);
		expect(items).toEqual([{ json: { id: 1, name: 'a' }, pairedItem: [{ item: 0 }] }]);
	});

	it('binds query parameters instead of interpolating them', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: {
				query: 'SELECT * FROM t WHERE id = ? AND name = ?',
				queryParameters: { parameter: [{ value: 7 }, { value: "o'brien" }] },
			},
		});

		await executeQuery(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT * FROM t WHERE id = @param0 AND name = @param1');
		expect(calls[0].parameters).toEqual({ param0: 7, param1: "o'brien" });
	});

	it('stamps pairedItem with the item being processed', async () => {
		const { pool } = recordingPool(rowsResult(['n'], [[1]]));
		const ctx = executeContext({ parameters: { query: 'SELECT 1 AS n' } });

		const items = await executeQuery(ctx, pool, testCredentials, 4);

		expect(items[0].pairedItem).toEqual([{ item: 4 }]);
	});

	it('rejects a write when the credential does not allow it', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: { query: 'DELETE FROM t' } });

		await expect(executeQuery(ctx, pool, testCredentials, 0)).rejects.toThrow(ReadOnlySqlError);
		expect(calls).toEqual([]);
	});

	it('does not contact the server when the guard rejects', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: { query: 'DROP TABLE t' } });

		await expect(executeQuery(ctx, pool, testCredentials, 0)).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it('allows a write when the credential opts in', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: {
				query: 'DELETE FROM t WHERE id = ?',
				queryParameters: { parameter: [{ value: 1 }] },
			},
		});

		await executeQuery(ctx, pool, writeEnabled, 0);

		expect(calls[0].sql).toBe('DELETE FROM t WHERE id = @param0');
	});

	it('still rejects an empty query when writes are allowed', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({ parameters: { query: '   ' } });

		await expect(executeQuery(ctx, pool, writeEnabled, 0)).rejects.toThrow(EmptySqlError);
	});

	it('rejects an empty query when writes are not allowed', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({ parameters: { query: '' } });

		await expect(executeQuery(ctx, pool, testCredentials, 0)).rejects.toThrow(EmptySqlError);
	});

	it('reports a placeholder count mismatch', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({
			parameters: {
				query: 'SELECT * FROM t WHERE a = ? AND b = ?',
				queryParameters: { parameter: [{ value: 1 }] },
			},
		});

		await expect(executeQuery(ctx, pool, testCredentials, 0)).rejects.toThrow(
			"Query has 2 '?' placeholders but 1 value was provided.",
		);
	});
});

describe('selectRows', () => {
	it('selects every column with a default limit', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: { table: { mode: 'list', value: 'dbo.t' } } });

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT TOP (@limit) * FROM [dbo].[t]');
		expect(calls[0].parameters).toEqual({ limit: 50 });
	});

	it('honors the configured limit', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: { table: { mode: 'list', value: 't' }, limit: 5 },
		});

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].parameters).toEqual({ limit: 5 });
	});

	it('drops TOP when returning all rows', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: { table: { mode: 'list', value: 't' }, returnAll: true },
		});

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT * FROM [t]');
		expect(calls[0].parameters).toEqual({});
	});

	it('quotes the named columns', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: {
				table: { mode: 'list', value: 't' },
				columns: 'id, name',
				returnAll: true,
			},
		});

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT [id], [name] FROM [t]');
	});

	it('binds filter values', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: {
				table: { mode: 'list', value: 't' },
				returnAll: true,
				filters: {
					condition: [
						{ column: 'id', operator: 'greaterThan', value: 10 },
						{ column: 'name', operator: 'isNotNull' },
					],
				},
			},
		});

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT * FROM [t] WHERE [id] > @w0 AND [name] IS NOT NULL');
		expect(calls[0].parameters).toEqual({ w0: 10 });
	});

	it('accepts a table name typed as free text', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({
			parameters: { table: { mode: 'name', value: 'dbo.orders' }, returnAll: true },
		});

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT * FROM [dbo].[orders]');
	});

	it('accepts a table name resolved from an expression to a plain string', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: { table: 'dbo.t', returnAll: true } });

		await selectRows(ctx, pool, testCredentials, 0);

		expect(calls[0].sql).toBe('SELECT * FROM [dbo].[t]');
	});

	it('reports an empty table rather than building broken SQL', async () => {
		const { pool, calls } = recordingPool();
		const ctx = executeContext({ parameters: { table: { mode: 'list', value: '' } } });

		await expect(selectRows(ctx, pool, testCredentials, 0)).rejects.toThrow('Table is empty');
		expect(calls).toHaveLength(0);
	});

	it('reports a filter with no column', async () => {
		const { pool } = recordingPool();
		const ctx = executeContext({
			parameters: {
				table: { mode: 'list', value: 't' },
				filters: { condition: [{ column: '  ', operator: 'equal', value: 1 }] },
			},
		});

		await expect(selectRows(ctx, pool, testCredentials, 0)).rejects.toThrow(
			'missing its column name',
		);
	});

	it('maps the returned rows', async () => {
		const { pool } = recordingPool(rowsResult(['id'], [[1], [2]]));
		const ctx = executeContext({ parameters: { table: { mode: 'list', value: 't' } } });

		const items = await selectRows(ctx, pool, testCredentials, 0);

		expect(items.map((item) => item.json)).toEqual([{ id: 1 }, { id: 2 }]);
	});
});
