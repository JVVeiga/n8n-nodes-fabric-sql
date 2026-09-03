import type { ILoadOptionsFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { describeTable } from '../../nodes/FabricSql/operations/describeTable';
import { listTables, toTableInfo } from '../../nodes/FabricSql/operations/listTables';
import { operations } from '../../nodes/FabricSql/operations';
import { searchTables } from '../../nodes/FabricSql/methods/listSearch';
import { toFabricSqlCredentials } from '../../nodes/FabricSql/transport/credentials';
import * as connection from '../../nodes/FabricSql/transport/connection';
import {
	emptyResult,
	executeContext,
	recordingPool,
	rowsResult,
	testCredentials,
	testNode,
} from '../helpers/context';

const tableRows = rowsResult(
	['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE'],
	[
		['dbo', 'orders', 'BASE TABLE'],
		['dbo', 'vw_summary', 'VIEW'],
	],
);

const columnRows = rowsResult(
	[
		'TABLE_SCHEMA',
		'TABLE_NAME',
		'COLUMN_NAME',
		'ORDINAL_POSITION',
		'DATA_TYPE',
		'CHARACTER_MAXIMUM_LENGTH',
		'NUMERIC_PRECISION',
		'NUMERIC_SCALE',
		'IS_NULLABLE',
		'COLUMN_DEFAULT',
	],
	[
		['dbo', 't', 'id', 1, 'int', null, 10, 0, 'NO', null],
		['dbo', 't', 'name', 2, 'varchar', 255, null, null, 'YES', null],
	],
);

describe('registry', () => {
	it('registers both schema operations', () => {
		expect(Object.keys(operations)).toEqual(
			expect.arrayContaining(['schema:listTables', 'schema:describeTable']),
		);
	});
});

describe('toTableInfo', () => {
	it('adds the qualified name every other operation needs', () => {
		expect(toTableInfo(tableRows)).toEqual([
			{
				schema: 'dbo',
				name: 'orders',
				qualifiedName: 'dbo.orders',
				type: 'BASE TABLE',
			},
			{ schema: 'dbo', name: 'vw_summary', qualifiedName: 'dbo.vw_summary', type: 'VIEW' },
		]);
	});

	it('omits the dot when there is no schema', () => {
		const rows = rowsResult(['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE'], [['', 't', 'VIEW']]);

		expect(toTableInfo(rows)[0].qualifiedName).toBe('t');
	});
});

describe('listTables', () => {
	it('queries INFORMATION_SCHEMA and returns one item per table', async () => {
		const { pool, calls } = recordingPool(tableRows);

		const items = await listTables(executeContext(), pool, testCredentials, 0);

		expect(calls[0].sql).toContain('FROM INFORMATION_SCHEMA.TABLES');
		expect(items).toHaveLength(2);
		expect(items[0].json.qualifiedName).toBe('dbo.orders');
		expect(items[0].pairedItem).toEqual([{ item: 0 }]);
	});

	it('returns no items when nothing is visible', async () => {
		const { pool } = recordingPool(emptyResult);

		await expect(listTables(executeContext(), pool, testCredentials, 0)).resolves.toEqual([]);
	});
});

describe('describeTable', () => {
	it('binds the table name and reshapes the column metadata', async () => {
		const { pool, calls } = recordingPool(columnRows);
		const ctx = executeContext({ parameters: { table: { mode: 'list', value: 'dbo.t' } } });

		const items = await describeTable(ctx, pool, testCredentials, 0);

		expect(calls[0].parameters).toEqual({ schema: 'dbo', table: 't' });
		expect(items[0].json).toEqual({
			schema: 'dbo',
			table: 't',
			name: 'id',
			position: 1,
			dataType: 'int',
			maxLength: null,
			precision: 10,
			scale: 0,
			nullable: false,
			default: null,
		});
	});

	it('reads IS_NULLABLE as a boolean', async () => {
		const { pool } = recordingPool(columnRows);
		const ctx = executeContext({ parameters: { table: { mode: 'list', value: 'dbo.t' } } });

		const items = await describeTable(ctx, pool, testCredentials, 0);

		expect(items[1].json.nullable).toBe(true);
	});

	it('returns no items for a table that does not exist', async () => {
		const { pool } = recordingPool(emptyResult);
		const ctx = executeContext({ parameters: { table: { mode: 'name', value: 'nope' } } });

		await expect(describeTable(ctx, pool, testCredentials, 0)).resolves.toEqual([]);
	});
});

describe('searchTables', () => {
	function loadOptionsContext() {
		return {
			getCredentials: async () => ({ ...testCredentials }),
			getNode: () => testNode,
		} as unknown as ILoadOptionsFunctions;
	}

	it('offers every table as an option', async () => {
		const spy = vi
			.spyOn(connection, 'withPool')
			.mockImplementation(async (_credentials, fn) => await fn(recordingPool(tableRows).pool));

		const result = await searchTables.call(loadOptionsContext());

		expect(result.results.map((entry) => entry.value)).toEqual([
			'dbo.orders',
			'dbo.vw_summary',
		]);
		spy.mockRestore();
	});

	it('filters by substring, case-insensitively', async () => {
		const spy = vi
			.spyOn(connection, 'withPool')
			.mockImplementation(async (_credentials, fn) => await fn(recordingPool(tableRows).pool));

		const result = await searchTables.call(loadOptionsContext(), 'VW_');

		expect(result.results.map((entry) => entry.value)).toEqual(['dbo.vw_summary']);
		spy.mockRestore();
	});

	it('surfaces a mapped connection error instead of an empty list', async () => {
		const spy = vi.spyOn(connection, 'withPool').mockImplementation(async () => {
			throw new Error('AADSTS7000215: Invalid client secret provided.');
		});

		await expect(searchTables.call(loadOptionsContext())).rejects.toThrow(
			/Client secret was rejected by Entra ID/,
		);
		spy.mockRestore();
	});
});

describe('toFabricSqlCredentials', () => {
	it('reads every field', () => {
		expect(
			toFabricSqlCredentials({
				server: 'abc.fabric.microsoft.com',
				database: 'lake',
				tenantId: 't',
				clientId: 'c',
				clientSecret: 's',
				connectTimeout: 1000,
				requestTimeout: 2000,
				allowWriteOperations: true,
			}),
		).toEqual({
			server: 'abc.fabric.microsoft.com',
			database: 'lake',
			tenantId: 't',
			clientId: 'c',
			clientSecret: 's',
			connectTimeout: 1000,
			requestTimeout: 2000,
			allowWriteOperations: true,
		});
	});

	it('defaults the timeouts on a credential saved before those fields existed', () => {
		const credentials = toFabricSqlCredentials({ server: 'a', database: 'b' });

		expect(credentials.connectTimeout).toBe(30_000);
		expect(credentials.requestTimeout).toBe(30_000);
	});

	it('treats a missing write toggle as disabled', () => {
		expect(toFabricSqlCredentials({}).allowWriteOperations).toBe(false);
	});

	it('does not accept a truthy non-boolean as opting into writes', () => {
		expect(toFabricSqlCredentials({ allowWriteOperations: 'yes' }).allowWriteOperations).toBe(
			false,
		);
	});
});
