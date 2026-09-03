import { describe, expect, it } from 'vitest';

import { PlaceholderCountError } from '../../nodes/FabricSql/core/errors';
import { bindPlaceholders, countPlaceholders } from '../../nodes/FabricSql/core/placeholders';
import { codeOnly } from '../../nodes/FabricSql/core/scanner';

describe('countPlaceholders', () => {
	it('counts placeholders in plain SQL', () => {
		expect(countPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(2);
	});

	it('ignores a ? inside a single-quoted string', () => {
		expect(countPlaceholders("SELECT 'why?' FROM t WHERE a = ?")).toBe(1);
	});

	it('ignores a ? inside a string that contains a doubled quote', () => {
		expect(countPlaceholders("SELECT 'it''s a ?' FROM t")).toBe(0);
	});

	it('ignores a ? inside a line comment', () => {
		expect(countPlaceholders('SELECT 1 -- what about ?\nWHERE a = ?')).toBe(1);
	});

	it('ignores a ? inside a block comment', () => {
		expect(countPlaceholders('SELECT /* ? ? ? */ 1 WHERE a = ?')).toBe(1);
	});

	it('ignores a ? inside a nested block comment', () => {
		expect(countPlaceholders('SELECT /* a /* ? */ ? */ 1 WHERE a = ?')).toBe(1);
	});

	it('ignores a ? inside a bracketed identifier', () => {
		expect(countPlaceholders('SELECT [why?] FROM t WHERE a = ?')).toBe(1);
	});

	it('ignores a ? inside a double-quoted identifier', () => {
		expect(countPlaceholders('SELECT "why?" FROM t WHERE a = ?')).toBe(1);
	});

	it('does not treat a lone - as the start of a comment', () => {
		expect(countPlaceholders('SELECT 1 - 2 WHERE a = ?')).toBe(1);
	});

	it('does not treat a lone / as the start of a comment', () => {
		expect(countPlaceholders('SELECT 4 / 2 WHERE a = ?')).toBe(1);
	});

	it('handles an unterminated line comment at end of input', () => {
		expect(countPlaceholders('SELECT 1 -- trailing ?')).toBe(0);
	});

	it('returns zero for SQL with no placeholders', () => {
		expect(countPlaceholders('SELECT TOP 10 * FROM dbo.orders')).toBe(0);
	});
});

describe('bindPlaceholders', () => {
	it('replaces placeholders with named parameters in order', () => {
		const built = bindPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?', [1, 'two']);

		expect(built.sql).toBe('SELECT * FROM t WHERE a = @param0 AND b = @param1');
		expect(built.parameters).toEqual({ param0: 1, param1: 'two' });
	});

	it('never puts the value into the SQL text', () => {
		const built = bindPlaceholders('SELECT * FROM t WHERE a = ?', ["'; DROP TABLE t; --"]);

		expect(built.sql).toBe('SELECT * FROM t WHERE a = @param0');
		expect(built.sql).not.toContain('DROP');
		expect(built.parameters.param0).toBe("'; DROP TABLE t; --");
	});

	it('leaves SQL untouched when there are no placeholders', () => {
		const built = bindPlaceholders('SELECT 1', []);

		expect(built.sql).toBe('SELECT 1');
		expect(built.parameters).toEqual({});
	});

	it('does not rewrite a ? that lives inside a literal', () => {
		const built = bindPlaceholders("SELECT 'why?' WHERE a = ?", [7]);

		expect(built.sql).toBe("SELECT 'why?' WHERE a = @param0");
		expect(built.parameters).toEqual({ param0: 7 });
	});

	it('preserves null and undefined values as bound parameters', () => {
		const built = bindPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?', [null, undefined]);

		expect(built.parameters).toEqual({ param0: null, param1: undefined });
	});

	it('throws when there are more placeholders than values', () => {
		expect(() => bindPlaceholders('SELECT ?, ?, ?', [1, 2])).toThrow(PlaceholderCountError);
	});

	it('reports both counts in the mismatch message', () => {
		expect(() => bindPlaceholders('SELECT ?, ?, ?', [1, 2])).toThrow(
			"Query has 3 '?' placeholders but 2 values were provided.",
		);
	});

	it('throws when there are more values than placeholders', () => {
		expect(() => bindPlaceholders('SELECT ?', [1, 2])).toThrow(
			"Query has 1 '?' placeholder but 2 values were provided.",
		);
	});

	it('uses singular wording for a single value', () => {
		expect(() => bindPlaceholders('SELECT ?, ?', [1])).toThrow(
			"Query has 2 '?' placeholders but 1 value was provided.",
		);
	});

	it('exposes the counts on the error', () => {
		try {
			bindPlaceholders('SELECT ?, ?', [1]);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(PlaceholderCountError);
			expect((error as PlaceholderCountError).expected).toBe(2);
			expect((error as PlaceholderCountError).received).toBe(1);
		}
	});
});

describe('codeOnly', () => {
	it('blanks literals and comments while preserving offsets', () => {
		const sql = "SELECT 'abc' -- x\nFROM t";
		const masked = codeOnly(sql);

		expect(masked).toHaveLength(sql.length);
		expect(masked).toBe('SELECT' + ' '.repeat(11) + '\nFROM t');
	});

	it('keeps line breaks so line numbers still line up', () => {
		expect(codeOnly('-- a\n-- b\nSELECT 1')).toBe('    \n    \nSELECT 1');
	});

	it('blanks a bracketed identifier', () => {
		expect(codeOnly('SELECT [a] FROM t')).toBe('SELECT     FROM t');
	});
});
