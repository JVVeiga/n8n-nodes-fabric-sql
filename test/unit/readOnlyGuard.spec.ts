import { describe, expect, it } from 'vitest';

import { EmptySqlError, ReadOnlySqlError } from '../../nodes/FabricSql/core/errors';
import { assertReadOnly, splitStatements } from '../../nodes/FabricSql/core/readOnlyGuard';

describe('assertReadOnly — allowed', () => {
	it('allows a plain SELECT', () => {
		expect(() => assertReadOnly('SELECT TOP 10 * FROM dbo.orders')).not.toThrow();
	});

	it('allows lowercase select', () => {
		expect(() => assertReadOnly('select 1')).not.toThrow();
	});

	it('allows a CTE that ends in SELECT', () => {
		expect(() => assertReadOnly('WITH c AS (SELECT 1 AS n) SELECT n FROM c')).not.toThrow();
	});

	it('allows a parenthesised SELECT', () => {
		expect(() => assertReadOnly('(SELECT 1) UNION ALL (SELECT 2)')).not.toThrow();
	});

	it('allows DECLARE followed by SELECT', () => {
		expect(() =>
			assertReadOnly("DECLARE @d date = '2026-01-01'; SELECT * FROM t WHERE d > @d"),
		).not.toThrow();
	});

	it('allows a trailing semicolon', () => {
		expect(() => assertReadOnly('SELECT 1;')).not.toThrow();
	});

	it('allows a column whose name merely contains a forbidden keyword', () => {
		expect(() => assertReadOnly('SELECT insert_count, update_ts FROM t')).not.toThrow();
	});

	it('allows a table whose name merely contains a forbidden keyword', () => {
		expect(() => assertReadOnly('SELECT * FROM dbo.delete_log')).not.toThrow();
	});

	it('allows a forbidden keyword inside a string literal', () => {
		expect(() => assertReadOnly("SELECT * FROM t WHERE action = 'DELETE'")).not.toThrow();
	});

	it('allows a forbidden keyword inside a comment', () => {
		expect(() => assertReadOnly('SELECT 1 -- we used to DELETE here')).not.toThrow();
	});

	it('allows a forbidden keyword inside a bracketed identifier', () => {
		expect(() => assertReadOnly('SELECT [delete] FROM t')).not.toThrow();
	});
});

describe('assertReadOnly — rejected', () => {
	it.each([
		['INSERT INTO t (a) VALUES (1)', 'INSERT'],
		['UPDATE t SET a = 1', 'UPDATE'],
		['DELETE FROM t', 'DELETE'],
		['MERGE t AS target USING s ON 1=1', 'MERGE'],
		['DROP TABLE t', 'DROP'],
		['ALTER TABLE t ADD b int', 'ALTER'],
		['CREATE TABLE t (a int)', 'CREATE'],
		['TRUNCATE TABLE t', 'TRUNCATE'],
		['EXEC sp_who', 'EXEC'],
		['EXECUTE sp_who', 'EXECUTE'],
		['GRANT SELECT ON t TO someone', 'GRANT'],
		['REVOKE SELECT ON t FROM someone', 'REVOKE'],
	])('rejects %s', (sql, keyword) => {
		expect(() => assertReadOnly(sql)).toThrow(ReadOnlySqlError);
		expect(() => assertReadOnly(sql)).toThrow(new RegExp(`${keyword} is not allowed`));
	});

	it('exposes the offending keyword on the error', () => {
		try {
			assertReadOnly('DELETE FROM t');
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as ReadOnlySqlError).keyword).toBe('DELETE');
		}
	});

	it('explains that writes need a Warehouse and the credential toggle', () => {
		expect(() => assertReadOnly('DELETE FROM t')).toThrow(/Fabric Warehouse/);
		expect(() => assertReadOnly('DELETE FROM t')).toThrow(/Allow Write Operations/);
	});

	it('checks every statement, not just the first', () => {
		expect(() => assertReadOnly('SELECT 1; DROP TABLE t')).toThrow(/DROP is not allowed/);
	});

	it('catches a CTE that ends in a write', () => {
		expect(() => assertReadOnly('WITH c AS (SELECT 1) DELETE FROM c')).toThrow(
			/DELETE is not allowed/,
		);
	});

	it('is not fooled by a semicolon inside a string literal', () => {
		expect(() => assertReadOnly("SELECT ';'; DROP TABLE t")).toThrow(/DROP is not allowed/);
	});

	it('rejects an unknown leading keyword', () => {
		expect(() => assertReadOnly('SHUTDOWN')).toThrow(/SHUTDOWN is not allowed/);
	});
});

describe('assertReadOnly — empty input', () => {
	it('rejects an empty query', () => {
		expect(() => assertReadOnly('')).toThrow(EmptySqlError);
	});

	it('rejects a whitespace-only query', () => {
		expect(() => assertReadOnly('  \n\t ')).toThrow(EmptySqlError);
	});

	it('rejects a query that is only a comment', () => {
		expect(() => assertReadOnly('-- nothing to see')).toThrow(EmptySqlError);
	});

	it('rejects a query that is only semicolons', () => {
		expect(() => assertReadOnly(';;;')).toThrow(EmptySqlError);
	});
});

describe('splitStatements', () => {
	it('splits on unquoted semicolons', () => {
		expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', ' SELECT 2']);
	});

	it('does not split on a semicolon inside a string', () => {
		expect(splitStatements("SELECT 'a;b'")).toEqual(["SELECT 'a;b'"]);
	});

	it('does not split on a semicolon inside a comment', () => {
		expect(splitStatements('SELECT 1 /* ; */')).toEqual(['SELECT 1 /* ; */']);
	});

	it('drops empty and comment-only fragments', () => {
		expect(splitStatements('SELECT 1;; -- tail')).toEqual(['SELECT 1']);
	});
});
