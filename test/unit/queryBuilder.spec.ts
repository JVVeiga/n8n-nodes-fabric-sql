import { describe, expect, it } from 'vitest';

import { FabricSqlError, InvalidIdentifierError } from '../../nodes/FabricSql/core/errors';
import {
	MSSQL_PARAMETER_LIMIT,
	buildDelete,
	buildInsert,
	buildSelect,
	buildUpdate,
	chunkByParameterLimit,
	describeTableQuery,
	listTablesQuery,
} from '../../nodes/FabricSql/core/queryBuilder';

describe('buildSelect', () => {
	it('selects every column when none are named', () => {
		expect(buildSelect({ table: 'dbo.t' })).toEqual({
			sql: 'SELECT * FROM [dbo].[t]',
			parameters: {},
		});
	});

	it('quotes each named column', () => {
		expect(buildSelect({ table: 't', columns: ['a', 'b'] }).sql).toBe(
			'SELECT [a], [b] FROM [t]',
		);
	});

	it('binds the limit rather than inlining it', () => {
		const built = buildSelect({ table: 't', limit: 10 });

		expect(built.sql).toBe('SELECT TOP (@limit) * FROM [t]');
		expect(built.parameters).toEqual({ limit: 10 });
	});

	it('omits TOP when the limit is zero', () => {
		expect(buildSelect({ table: 't', limit: 0 }).sql).toBe('SELECT * FROM [t]');
	});

	it('binds where values', () => {
		const built = buildSelect({
			table: 't',
			where: [{ column: 'a', operator: 'equal', value: 1 }],
		});

		expect(built.sql).toBe('SELECT * FROM [t] WHERE [a] = @w0');
		expect(built.parameters).toEqual({ w0: 1 });
	});

	it('joins multiple conditions with AND', () => {
		const built = buildSelect({
			table: 't',
			where: [
				{ column: 'a', operator: 'greaterThan', value: 1 },
				{ column: 'b', operator: 'like', value: '%x%' },
			],
		});

		expect(built.sql).toBe('SELECT * FROM [t] WHERE [a] > @w0 AND [b] LIKE @w1');
		expect(built.parameters).toEqual({ w0: 1, w1: '%x%' });
	});

	it('binds nothing for IS NULL', () => {
		const built = buildSelect({ table: 't', where: [{ column: 'a', operator: 'isNull' }] });

		expect(built.sql).toBe('SELECT * FROM [t] WHERE [a] IS NULL');
		expect(built.parameters).toEqual({});
	});

	it('binds nothing for IS NOT NULL', () => {
		expect(
			buildSelect({ table: 't', where: [{ column: 'a', operator: 'isNotNull' }] }).sql,
		).toBe('SELECT * FROM [t] WHERE [a] IS NOT NULL');
	});

	it.each([
		['equal', '='],
		['notEqual', '<>'],
		['greaterThan', '>'],
		['greaterThanOrEqual', '>='],
		['lessThan', '<'],
		['lessThanOrEqual', '<='],
		['like', 'LIKE'],
	] as const)('maps %s to %s', (operator, sql) => {
		expect(buildSelect({ table: 't', where: [{ column: 'a', operator, value: 1 }] }).sql).toBe(
			`SELECT * FROM [t] WHERE [a] ${sql} @w0`,
		);
	});

	it('binds null for a condition with no value', () => {
		const built = buildSelect({ table: 't', where: [{ column: 'a', operator: 'equal' }] });

		expect(built.parameters).toEqual({ w0: null });
	});

	it('rejects an unsupported operator', () => {
		expect(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			buildSelect({ table: 't', where: [{ column: 'a', operator: 'drop' as any, value: 1 }] }),
		).toThrow(FabricSqlError);
	});

	it('neutralizes an injection attempt in a column name', () => {
		const built = buildSelect({ table: 't', columns: ['a] FROM sys.tables --'] });

		expect(built.sql).toBe('SELECT [a]] FROM sys.tables --] FROM [t]');
	});

	it('rejects an empty table name', () => {
		expect(() => buildSelect({ table: '  ' })).toThrow(InvalidIdentifierError);
	});

	it('never puts a where value into the SQL text', () => {
		const built = buildSelect({
			table: 't',
			where: [{ column: 'a', operator: 'equal', value: "'; DROP TABLE t; --" }],
		});

		expect(built.sql).not.toContain('DROP');
	});
});

describe('buildInsert', () => {
	it('builds a single multi-row statement with every value bound', () => {
		const built = buildInsert('dbo.t', ['a', 'b'], [
			{ a: 1, b: 'x' },
			{ a: 2, b: 'y' },
		]);

		expect(built).toHaveLength(1);
		expect(built[0].sql).toBe(
			'INSERT INTO [dbo].[t] ([a], [b]) VALUES (@r0c0, @r0c1), (@r1c0, @r1c1)',
		);
		expect(built[0].parameters).toEqual({ r0c0: 1, r0c1: 'x', r1c0: 2, r1c1: 'y' });
	});

	it('binds null for a column missing from a row', () => {
		const built = buildInsert('t', ['a', 'b'], [{ a: 1 }]);

		expect(built[0].parameters).toEqual({ r0c0: 1, r0c1: null });
	});

	it('returns no statements for no rows', () => {
		expect(buildInsert('t', ['a'], [])).toEqual([]);
	});

	it('rejects an insert with no columns', () => {
		expect(() => buildInsert('t', [], [{ a: 1 }])).toThrow('at least one column');
	});

	it('splits into chunks so no statement exceeds the parameter limit', () => {
		const rows = Array.from({ length: 1500 }, (_, index) => ({ a: index, b: index }));
		const built = buildInsert('t', ['a', 'b'], rows);

		expect(built).toHaveLength(2);
		for (const statement of built) {
			expect(Object.keys(statement.parameters).length).toBeLessThanOrEqual(
				MSSQL_PARAMETER_LIMIT,
			);
		}
		expect(
			built.reduce((sum, statement) => sum + Object.keys(statement.parameters).length, 0),
		).toBe(3000);
	});
});

describe('buildUpdate', () => {
	it('binds the set values and the match value', () => {
		const built = buildUpdate('dbo.t', ['a', 'b'], { a: 1, b: 'x', id: 7 }, 'id');

		expect(built.sql).toBe('UPDATE [dbo].[t] SET [a] = @s0, [b] = @s1 WHERE [id] = @match');
		expect(built.parameters).toEqual({ match: 7, s0: 1, s1: 'x' });
	});

	it('does not assign the match column to itself', () => {
		const built = buildUpdate('t', ['id', 'a'], { id: 7, a: 1 }, 'id');

		expect(built.sql).toBe('UPDATE [t] SET [a] = @s0 WHERE [id] = @match');
	});

	it('rejects an update with nothing to set', () => {
		expect(() => buildUpdate('t', ['id'], { id: 7 }, 'id')).toThrow('at least one column other');
	});

	it('binds null for a missing match value', () => {
		expect(buildUpdate('t', ['a'], { a: 1 }, 'id').parameters.match).toBeNull();
	});
});

describe('buildDelete', () => {
	it('binds every match value into an IN list', () => {
		const built = buildDelete('dbo.t', 'id', [1, 2, 3]);

		expect(built).toHaveLength(1);
		expect(built[0].sql).toBe('DELETE FROM [dbo].[t] WHERE [id] IN (@m0, @m1, @m2)');
		expect(built[0].parameters).toEqual({ m0: 1, m1: 2, m2: 3 });
	});

	it('returns no statements when there is nothing to delete', () => {
		expect(buildDelete('t', 'id', [])).toEqual([]);
	});

	it('chunks a long IN list', () => {
		const built = buildDelete('t', 'id', Array.from({ length: 2101 }, (_, i) => i));

		expect(built).toHaveLength(2);
		expect(Object.keys(built[0].parameters)).toHaveLength(MSSQL_PARAMETER_LIMIT);
		expect(Object.keys(built[1].parameters)).toHaveLength(1);
	});
});

describe('chunkByParameterLimit', () => {
	it('returns no chunks for no rows', () => {
		expect(chunkByParameterLimit([], 2)).toEqual([]);
	});

	it('keeps everything in one chunk at exactly the limit', () => {
		const rows = Array.from({ length: MSSQL_PARAMETER_LIMIT }, (_, i) => i);

		expect(chunkByParameterLimit(rows, 1)).toHaveLength(1);
	});

	it('keeps everything in one chunk just under the limit', () => {
		const rows = Array.from({ length: MSSQL_PARAMETER_LIMIT - 1 }, (_, i) => i);

		expect(chunkByParameterLimit(rows, 1)).toHaveLength(1);
	});

	it('splits one row past the limit', () => {
		const rows = Array.from({ length: MSSQL_PARAMETER_LIMIT + 1 }, (_, i) => i);
		const chunks = chunkByParameterLimit(rows, 1);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(MSSQL_PARAMETER_LIMIT);
		expect(chunks[1]).toHaveLength(1);
	});

	it('accounts for parameters per row', () => {
		const rows = Array.from({ length: 1051 }, (_, i) => i);
		const chunks = chunkByParameterLimit(rows, 2);

		expect(chunks[0]).toHaveLength(1050);
		expect(chunks[1]).toHaveLength(1);
	});

	it('treats a zero parameter count as a single chunk', () => {
		expect(chunkByParameterLimit([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
	});

	it('rejects a row that alone exceeds the limit', () => {
		expect(() => chunkByParameterLimit([{}], MSSQL_PARAMETER_LIMIT + 1)).toThrow(
			/over the 2100-parameter limit/,
		);
	});

	it('respects a custom limit', () => {
		expect(chunkByParameterLimit([1, 2, 3, 4], 1, 2)).toEqual([
			[1, 2],
			[3, 4],
		]);
	});
});

describe('listTablesQuery', () => {
	it('reads INFORMATION_SCHEMA.TABLES with no parameters', () => {
		const built = listTablesQuery();

		expect(built.sql).toContain('FROM INFORMATION_SCHEMA.TABLES');
		expect(built.sql).toContain('ORDER BY TABLE_SCHEMA, TABLE_NAME');
		expect(built.parameters).toEqual({});
	});
});

describe('describeTableQuery', () => {
	it('binds the table name as a value, not an identifier', () => {
		const built = describeTableQuery('orders');

		expect(built.sql).toContain('WHERE TABLE_NAME = @table');
		expect(built.sql).not.toContain('[orders]');
		expect(built.parameters).toEqual({ table: 'orders' });
	});

	it('binds the schema separately for a qualified name', () => {
		const built = describeTableQuery('dbo.orders');

		expect(built.sql).toContain('AND TABLE_SCHEMA = @schema');
		expect(built.parameters).toEqual({ schema: 'dbo', table: 'orders' });
	});

	it('uses the last two parts of a three-part name', () => {
		expect(describeTableQuery('my_lakehouse.dbo.t').parameters).toEqual({
			schema: 'dbo',
			table: 't',
		});
	});

	it('unwraps bracketed parts before binding', () => {
		expect(describeTableQuery('[dbo].[my.table]').parameters).toEqual({
			schema: 'dbo',
			table: 'my.table',
		});
	});

	it('does not let a table name inject SQL, because it is bound', () => {
		const built = describeTableQuery("t' OR 1=1 --");

		expect(built.sql).not.toContain('OR 1=1');
		expect(built.parameters.table).toBe("t' OR 1=1 --");
	});

	it('rejects an empty table name', () => {
		expect(() => describeTableQuery('   ')).toThrow('Table name is empty.');
	});

	it('rejects a name with an empty part', () => {
		expect(() => describeTableQuery('dbo..t')).toThrow('Table name is empty.');
	});
});
