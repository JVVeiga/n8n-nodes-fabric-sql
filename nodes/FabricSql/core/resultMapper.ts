import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

import type { QueryResultLike } from '../types';

/**
 * Give every column a usable, unique key.
 *
 * Unnamed columns (an unaliased expression) become `column_<index>`. Repeated names keep the
 * first occurrence and suffix the rest, so `SELECT a.id, b.id` yields `id` and `id_1` instead
 * of one of them overwriting the other.
 */
export function normalizeColumnNames(names: string[]): string[] {
	const used = new Set<string>();

	return names.map((raw, index) => {
		const base = raw?.trim() ? raw.trim() : `column_${index}`;

		if (!used.has(base)) {
			used.add(base);
			return base;
		}

		let suffix = 1;
		while (used.has(`${base}_${suffix}`)) {
			suffix += 1;
		}

		const unique = `${base}_${suffix}`;
		used.add(unique);

		return unique;
	});
}

/**
 * Convert a driver value into something JSON can carry.
 *
 * `varbinary` arrives as a Buffer, dates as Date, `bigint` as a JS BigInt — all three break
 * or lose information when a workflow serializes them, so each gets an explicit
 * representation. Everything else passes through untouched.
 */
export function coerceValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (Buffer.isBuffer(value)) {
		return value.toString('base64');
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (typeof value === 'bigint') {
		return value.toString();
	}

	if (Array.isArray(value)) {
		return value.map(coerceValue);
	}

	if (isPlainObject(value)) {
		const out: IDataObject = {};

		for (const [key, nested] of Object.entries(value)) {
			out[key] = coerceValue(nested) as IDataObject[string];
		}

		return out;
	}

	return value;
}

/**
 * Turn a query result into n8n items — one per row, across every recordset.
 *
 * Multiple recordsets are flattened into one stream: a workflow branch expects items, not a
 * nested structure it has to unpack. A result with no rows still produces one item, so the
 * branch runs and can report what happened.
 */
export function mapRecordsets(result: QueryResultLike, itemIndex: number): INodeExecutionData[] {
	const items: INodeExecutionData[] = [];
	const recordsets = result.recordsets ?? [];

	recordsets.forEach((rows, recordsetIndex) => {
		const metadata = result.columns?.[recordsetIndex] ?? [];
		const widest = rows.reduce((max, row) => Math.max(max, row.length), metadata.length);
		const names = normalizeColumnNames(
			Array.from({ length: widest }, (_, index) => metadata[index]?.name ?? ''),
		);

		for (const row of rows) {
			const json: IDataObject = {};

			names.forEach((name, columnIndex) => {
				json[name] = coerceValue(row[columnIndex]) as IDataObject[string];
			});

			items.push({ json, pairedItem: [{ item: itemIndex }] });
		}
	});

	if (items.length > 0) {
		return items;
	}

	return [
		{
			json: {
				message: 'Query executed successfully. No rows returned.',
				rowsAffected: totalRowsAffected(result),
			},
			pairedItem: [{ item: itemIndex }],
		},
	];
}

function totalRowsAffected(result: QueryResultLike): number {
	return (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const proto = Object.getPrototypeOf(value);

	return proto === Object.prototype || proto === null;
}
