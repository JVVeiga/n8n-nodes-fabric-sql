import { describe, expect, it } from 'vitest';

import {
	coerceValue,
	mapRecordsets,
	normalizeColumnNames,
} from '../../nodes/FabricSql/core/resultMapper';
import type { QueryResultLike } from '../../nodes/FabricSql/types';

function result(partial: Partial<QueryResultLike>): QueryResultLike {
	return {
		recordsets: [],
		rowsAffected: [],
		columns: [],
		...partial,
	};
}

function columns(...names: string[]) {
	return names.map((name, index) => ({ index, name }));
}

describe('normalizeColumnNames', () => {
	it('passes distinct names through', () => {
		expect(normalizeColumnNames(['a', 'b'])).toEqual(['a', 'b']);
	});

	it('suffixes a duplicate instead of dropping it', () => {
		expect(normalizeColumnNames(['id', 'id'])).toEqual(['id', 'id_1']);
	});

	it('suffixes each further duplicate incrementally', () => {
		expect(normalizeColumnNames(['id', 'id', 'id'])).toEqual(['id', 'id_1', 'id_2']);
	});

	it('does not collide with an existing name that looks like a suffix', () => {
		expect(normalizeColumnNames(['id', 'id_1', 'id'])).toEqual(['id', 'id_1', 'id_2']);
	});

	it('names an unnamed column by its position', () => {
		expect(normalizeColumnNames(['a', '', 'c'])).toEqual(['a', 'column_1', 'c']);
	});

	it('treats a whitespace-only name as unnamed', () => {
		expect(normalizeColumnNames(['  '])).toEqual(['column_0']);
	});

	it('trims a padded name', () => {
		expect(normalizeColumnNames([' a '])).toEqual(['a']);
	});
});

describe('coerceValue', () => {
	it('passes null and undefined through', () => {
		expect(coerceValue(null)).toBeNull();
		expect(coerceValue(undefined)).toBeUndefined();
	});

	it('base64-encodes a Buffer', () => {
		expect(coerceValue(Buffer.from('hi'))).toBe('aGk=');
	});

	it('converts a Date to an ISO string', () => {
		expect(coerceValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
	});

	it('converts a bigint to a decimal string without losing precision', () => {
		expect(coerceValue(BigInt('9007199254740993'))).toBe('9007199254740993');
	});

	it('passes primitives through', () => {
		expect(coerceValue(42)).toBe(42);
		expect(coerceValue('x')).toBe('x');
		expect(coerceValue(true)).toBe(true);
	});

	it('walks arrays', () => {
		expect(coerceValue([BigInt(1), Buffer.from('a')])).toEqual(['1', 'YQ==']);
	});

	it('walks plain objects', () => {
		expect(coerceValue({ a: BigInt(1), b: { c: Buffer.from('a') } })).toEqual({
			a: '1',
			b: { c: 'YQ==' },
		});
	});

	it('leaves a class instance alone rather than shredding it', () => {
		class Point {
			constructor(readonly x: number) {}
		}
		const point = new Point(1);

		expect(coerceValue(point)).toBe(point);
	});
});

describe('mapRecordsets', () => {
	it('returns one item per row with the column names applied', () => {
		const items = mapRecordsets(
			result({
				recordsets: [
					[
						['a', 1],
						['b', 2],
					],
				],
				columns: [columns('name', 'value')],
				rowsAffected: [2],
			}),
			0,
		);

		expect(items).toHaveLength(2);
		expect(items[0].json).toEqual({ name: 'a', value: 1 });
		expect(items[1].json).toEqual({ name: 'b', value: 2 });
	});

	it('stamps pairedItem with the input index that produced the rows', () => {
		const items = mapRecordsets(result({ recordsets: [[[1]]], columns: [columns('n')] }), 3);

		expect(items[0].pairedItem).toEqual([{ item: 3 }]);
	});

	it('keeps both columns when their names collide', () => {
		const items = mapRecordsets(
			result({
				recordsets: [[[7, 9]]],
				columns: [columns('id', 'id')],
			}),
			0,
		);

		expect(items[0].json).toEqual({ id: 7, id_1: 9 });
	});

	it('flattens multiple recordsets into one item stream', () => {
		const items = mapRecordsets(
			result({
				recordsets: [[[1]], [['x'], ['y']]],
				columns: [columns('n'), columns('s')],
			}),
			0,
		);

		expect(items.map((item) => item.json)).toEqual([{ n: 1 }, { s: 'x' }, { s: 'y' }]);
	});

	it('coerces values inside rows', () => {
		const items = mapRecordsets(
			result({
				recordsets: [[[new Date('2026-01-01T00:00:00.000Z'), Buffer.from('hi'), BigInt(5)]]],
				columns: [columns('at', 'blob', 'big')],
			}),
			0,
		);

		expect(items[0].json).toEqual({
			at: '2026-01-01T00:00:00.000Z',
			blob: 'aGk=',
			big: '5',
		});
	});

	it('reports success with zero rows when nothing came back', () => {
		const items = mapRecordsets(result({ recordsets: [[]], rowsAffected: [0] }), 0);

		expect(items).toHaveLength(1);
		expect(items[0].json).toEqual({
			message: 'Query executed successfully. No rows returned.',
			rowsAffected: 0,
		});
	});

	it('sums rowsAffected across statements on an empty result', () => {
		const items = mapRecordsets(result({ recordsets: [], rowsAffected: [2, 3] }), 0);

		expect(items[0].json.rowsAffected).toBe(5);
	});

	it('names columns positionally when metadata is missing', () => {
		const items = mapRecordsets(result({ recordsets: [[[1, 2]]], columns: [] }), 0);

		expect(items[0].json).toEqual({ column_0: 1, column_1: 2 });
	});

	it('covers rows wider than the metadata', () => {
		const items = mapRecordsets(result({ recordsets: [[[1, 2, 3]]], columns: [columns('a')] }), 0);

		expect(items[0].json).toEqual({ a: 1, column_1: 2, column_2: 3 });
	});

	it('preserves a null value rather than omitting the key', () => {
		const items = mapRecordsets(result({ recordsets: [[[null]]], columns: [columns('a')] }), 0);

		expect(items[0].json).toEqual({ a: null });
		expect('a' in items[0].json).toBe(true);
	});
});
