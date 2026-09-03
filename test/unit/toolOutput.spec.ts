import { describe, expect, it } from 'vitest';

import {
	applyRowCap,
	compactResult,
	formatSchemaDigest,
} from '../../nodes/FabricSql/core/toolOutput';
import type { QueryResultLike } from '../../nodes/FabricSql/types';

function result(columns: string[] = []): QueryResultLike {
	return {
		recordsets: [],
		rowsAffected: [],
		columns: [columns.map((name, index) => ({ index, name }))],
	};
}

function rowsOf(count: number, filler = 'x') {
	return Array.from({ length: count }, (_unused, id) => ({ id, value: filler }));
}

describe('applyRowCap', () => {
	it('injects TOP into a bare SELECT', () => {
		expect(applyRowCap('SELECT * FROM t', 100)).toBe('SELECT TOP (100) * FROM t');
	});

	it('preserves leading whitespace and the original spacing', () => {
		expect(applyRowCap('  SELECT\n  a FROM t', 5)).toBe('  SELECT TOP (5)\n  a FROM t');
	});

	it('is case-insensitive on the keyword', () => {
		expect(applyRowCap('select a from t', 5)).toBe('select TOP (5) a from t');
	});

	it('leaves a query that already has TOP alone', () => {
		expect(applyRowCap('SELECT TOP 10 * FROM t', 100)).toBe('SELECT TOP 10 * FROM t');
	});

	it('leaves a parenthesised TOP alone', () => {
		expect(applyRowCap('SELECT TOP (10) * FROM t', 100)).toBe('SELECT TOP (10) * FROM t');
	});

	it('does not rewrite DISTINCT, which sits where TOP would go', () => {
		expect(applyRowCap('SELECT DISTINCT a FROM t', 100)).toBe('SELECT DISTINCT a FROM t');
	});

	it('does not rewrite OFFSET/FETCH paging', () => {
		const sql = 'SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY';

		expect(applyRowCap(sql, 100)).toBe(sql);
	});

	it('does not rewrite a CTE, whose real SELECT is not the leading keyword', () => {
		const sql = 'WITH c AS (SELECT 1 AS n) SELECT n FROM c';

		expect(applyRowCap(sql, 100)).toBe(sql);
	});

	it('does not rewrite a multi-statement batch', () => {
		const sql = 'SELECT 1; SELECT 2';

		expect(applyRowCap(sql, 100)).toBe(sql);
	});

	it('is not fooled by the word TOP inside a string literal', () => {
		expect(applyRowCap("SELECT a FROM t WHERE b = 'TOP 5'", 7)).toBe(
			"SELECT TOP (7) a FROM t WHERE b = 'TOP 5'",
		);
	});

	it('does not rewrite SELECT INTO', () => {
		const sql = 'SELECT a INTO #tmp FROM t';

		expect(applyRowCap(sql, 100)).toBe(sql);
	});

	it('does nothing when the cap is zero or negative', () => {
		expect(applyRowCap('SELECT * FROM t', 0)).toBe('SELECT * FROM t');
		expect(applyRowCap('SELECT * FROM t', -1)).toBe('SELECT * FROM t');
	});
});

describe('compactResult', () => {
	it('returns one answer with the columns and the rows', () => {
		const compact = compactResult(result(['id', 'value']), rowsOf(3), {
			maxRows: 100,
			maxChars: 10_000,
		});

		expect(compact.columns).toEqual(['id', 'value']);
		expect(compact.rowCount).toBe(3);
		expect(compact.truncated).toBe(false);
		expect(compact.note).toBeUndefined();
	});

	it('caps at maxRows and says so', () => {
		const compact = compactResult(result(['id', 'value']), rowsOf(500), {
			maxRows: 10,
			maxChars: 100_000,
		});

		expect(compact.rows).toHaveLength(10);
		expect(compact.rowCount).toBe(10);
		expect(compact.truncated).toBe(true);
		expect(compact.note).toMatch(/narrow the query/);
	});

	it('drops further rows to fit the character budget', () => {
		const compact = compactResult(result(['id', 'value']), rowsOf(200, 'y'.repeat(200)), {
			maxRows: 200,
			maxChars: 2_000,
		});

		expect(compact.rows.length).toBeLessThan(200);
		expect(JSON.stringify(compact.rows).length).toBeLessThanOrEqual(2_000);
		expect(compact.truncated).toBe(true);
	});

	it('keeps one oversized row rather than answering with nothing', () => {
		const compact = compactResult(result(['id', 'value']), rowsOf(4, 'z'.repeat(5_000)), {
			maxRows: 100,
			maxChars: 100,
		});

		expect(compact.rows).toHaveLength(1);
		expect(compact.truncated).toBe(true);
	});

	it('handles an empty result', () => {
		const compact = compactResult(result(['id']), [], { maxRows: 100, maxChars: 10_000 });

		expect(compact.rows).toEqual([]);
		expect(compact.rowCount).toBe(0);
		expect(compact.truncated).toBe(false);
	});

	it('falls back to the row keys when there is no column metadata', () => {
		const compact = compactResult(
			{ recordsets: [], rowsAffected: [], columns: [] },
			[{ a: 1, b: 2 }],
			{ maxRows: 100, maxChars: 10_000 },
		);

		expect(compact.columns).toEqual(['a', 'b']);
	});
});

describe('formatSchemaDigest', () => {
	const columns = [
		{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'bug_reports', COLUMN_NAME: 'id', DATA_TYPE: 'int' },
		{
			TABLE_SCHEMA: 'dbo',
			TABLE_NAME: 'bug_reports',
			COLUMN_NAME: 'severity',
			DATA_TYPE: 'varchar',
		},
		{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'deploys', COLUMN_NAME: 'sha', DATA_TYPE: 'varchar' },
	];

	it('groups columns under their table', () => {
		const digest = formatSchemaDigest(columns, { maxChars: 10_000 });

		expect(digest).toContain('dbo.bug_reports(id int, severity varchar)');
		expect(digest).toContain('dbo.deploys(sha varchar)');
	});

	it('leads with a header the model can act on', () => {
		expect(formatSchemaDigest(columns, { maxChars: 10_000 })).toMatch(
			/^Available tables and columns:/,
		);
	});

	it('returns an empty string when there is nothing to describe', () => {
		expect(formatSchemaDigest([], { maxChars: 10_000 })).toBe('');
	});

	it('says nothing about partiality when the list is complete', () => {
		const digest = formatSchemaDigest(columns, { maxChars: 10_000 });

		expect(digest).not.toMatch(/partial list/);
	});

	it('drops tables past the budget and points at INFORMATION_SCHEMA', () => {
		const many = Array.from({ length: 200 }, (_unused, index) => ({
			TABLE_SCHEMA: 'dbo',
			TABLE_NAME: `table_${index}`,
			COLUMN_NAME: 'a_long_column_name_here',
			DATA_TYPE: 'varchar',
		}));

		const digest = formatSchemaDigest(many, { maxChars: 300 });

		expect(digest).toMatch(/partial list/);
		expect(digest).toMatch(/did not fit/);
		expect(digest).toContain('INFORMATION_SCHEMA.TABLES');
	});

	it('warns that a filter narrowed the list, even when everything listed fits', () => {
		// Without this the model cannot tell a deliberately filtered list from a complete one,
		// and concludes the tables it cannot see do not exist.
		const digest = formatSchemaDigest(columns, { maxChars: 10_000, tableFilter: 'bug_%' });

		expect(digest).toMatch(/partial list/);
		expect(digest).toContain('only tables matching "bug_%" are listed');
		expect(digest).toContain('INFORMATION_SCHEMA.TABLES');
	});

	it('names both causes when a filter and the budget both cut the list', () => {
		const many = Array.from({ length: 200 }, (_unused, index) => ({
			TABLE_SCHEMA: 'dbo',
			TABLE_NAME: `bug_table_${index}`,
			COLUMN_NAME: 'a_long_column_name_here',
			DATA_TYPE: 'varchar',
		}));

		const digest = formatSchemaDigest(many, { maxChars: 300, tableFilter: 'bug_%' });

		expect(digest).toContain('only tables matching "bug_%" are listed');
		expect(digest).toMatch(/and \d+ more tables? did not fit/);
	});

	it('keeps at least one table even with a tiny budget', () => {
		const digest = formatSchemaDigest(columns, { maxChars: 1 });

		expect(digest).toContain('dbo.bug_reports');
	});

	it('omits the schema prefix when there is none', () => {
		const digest = formatSchemaDigest(
			[{ TABLE_SCHEMA: '', TABLE_NAME: 't', COLUMN_NAME: 'a', DATA_TYPE: 'int' }],
			{ maxChars: 1_000 },
		);

		expect(digest).toContain('t(a int)');
	});

	it('skips rows missing a table or column name', () => {
		const digest = formatSchemaDigest([{ TABLE_SCHEMA: 'dbo', TABLE_NAME: '', COLUMN_NAME: 'a' }], {
			maxChars: 1_000,
		});

		expect(digest).toBe('');
	});
});
