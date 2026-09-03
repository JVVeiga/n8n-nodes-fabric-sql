import { describe, expect, it } from 'vitest';

import { InvalidIdentifierError } from '../../nodes/FabricSql/core/errors';
import {
	quoteIdentifier,
	quoteQualifiedName,
	splitQualifiedName,
	unbracket,
} from '../../nodes/FabricSql/core/identifiers';

describe('quoteIdentifier', () => {
	it('wraps a plain name in brackets', () => {
		expect(quoteIdentifier('foo')).toBe('[foo]');
	});

	it('trims surrounding whitespace', () => {
		expect(quoteIdentifier('  foo  ')).toBe('[foo]');
	});

	it('doubles a closing bracket so the identifier cannot be escaped', () => {
		expect(quoteIdentifier('a]b')).toBe('[a]]b]');
	});

	it('doubles every closing bracket, not just the first', () => {
		expect(quoteIdentifier('a]b]c')).toBe('[a]]b]]c]');
	});

	it('neutralizes an injection attempt that closes the bracket', () => {
		// The payload must end up inert inside one identifier, not as separate SQL.
		expect(quoteIdentifier('t] WHERE 1=1 --')).toBe('[t]] WHERE 1=1 --]');
	});

	it('leaves a dot alone — a dot is legal inside one identifier', () => {
		expect(quoteIdentifier('my.table')).toBe('[my.table]');
	});

	it('normalizes an already bracketed name', () => {
		expect(quoteIdentifier('[foo]')).toBe('[foo]');
	});

	it('round-trips a bracketed name that contains an escaped bracket', () => {
		expect(quoteIdentifier('[a]]b]')).toBe('[a]]b]');
	});

	it('keeps spaces inside the name', () => {
		expect(quoteIdentifier('silver solicitacao')).toBe('[silver solicitacao]');
	});

	it('rejects an empty name', () => {
		expect(() => quoteIdentifier('')).toThrow(InvalidIdentifierError);
	});

	it('rejects a whitespace-only name', () => {
		expect(() => quoteIdentifier('   ')).toThrow(InvalidIdentifierError);
	});

	it('rejects empty brackets', () => {
		expect(() => quoteIdentifier('[]')).toThrow(InvalidIdentifierError);
	});
});

describe('quoteQualifiedName', () => {
	it('quotes each part of a two-part name separately', () => {
		expect(quoteQualifiedName('dbo.t')).toBe('[dbo].[t]');
	});

	it('quotes a three-part name', () => {
		expect(quoteQualifiedName('my_lakehouse.dbo.orders')).toBe(
			'[my_lakehouse].[dbo].[orders]',
		);
	});

	it('normalizes a pre-bracketed qualified name', () => {
		expect(quoteQualifiedName('[dbo].[t]')).toBe('[dbo].[t]');
	});

	it('does not split on a dot inside brackets', () => {
		expect(quoteQualifiedName('[my.table]')).toBe('[my.table]');
	});

	it('handles a mix of bracketed and bare parts', () => {
		expect(quoteQualifiedName('dbo.[my.table]')).toBe('[dbo].[my.table]');
	});

	it('escapes a bracket in one part without affecting the others', () => {
		expect(quoteQualifiedName('dbo.a]b')).toBe('[dbo].[a]]b]');
	});

	it('rejects an empty name', () => {
		expect(() => quoteQualifiedName('  ')).toThrow(InvalidIdentifierError);
	});

	it('rejects a part that is empty', () => {
		expect(() => quoteQualifiedName('dbo..t')).toThrow(InvalidIdentifierError);
	});

	it('rejects more than three parts', () => {
		expect(() => quoteQualifiedName('a.b.c.d')).toThrow(/at most 3/);
	});
});

describe('splitQualifiedName', () => {
	it('returns an empty list for a blank name', () => {
		expect(splitQualifiedName('   ')).toEqual([]);
	});

	it('splits on unbracketed dots only', () => {
		expect(splitQualifiedName('dbo.[my.table]')).toEqual(['dbo', '[my.table]']);
	});

	it('returns a single part when there is no dot', () => {
		expect(splitQualifiedName('t')).toEqual(['t']);
	});
});

describe('unbracket', () => {
	it('strips outer brackets and undoubles escapes', () => {
		expect(unbracket('[a]]b]')).toBe('a]b');
	});

	it('passes a bare name through', () => {
		expect(unbracket('foo')).toBe('foo');
	});
});
