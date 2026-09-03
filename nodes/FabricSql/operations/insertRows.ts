import type { IDataObject } from 'n8n-workflow';

import { buildInsert } from '../core/queryBuilder';
import { runQuery } from '../transport/connection';
import type { BatchOperationHandler } from '../types';
import { getColumns, getTableName } from './params';
import { assertWritesAllowed } from './writeGuard';

/**
 * Insert every incoming item as a row.
 *
 * Batched rather than per item: `buildInsert` packs as many rows into each statement as the
 * 2100-parameter limit allows, which turns a thousand items into a couple of round trips
 * instead of a thousand.
 *
 * Warehouse only — a Lakehouse SQL analytics endpoint rejects writes.
 */
export const insertRows: BatchOperationHandler = async (ctx, pool, credentials, items) => {
	assertWritesAllowed(credentials, 'INSERT');

	const table = getTableName(ctx, 0);
	const columns = getColumns(ctx, 0);
	const rows = items.map((item) => item.json as IDataObject);

	let rowsAffected = 0;

	for (const built of buildInsert(table, columns, rows)) {
		const result = await runQuery(pool, built);
		rowsAffected += (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0);
	}

	return [
		{
			json: { operation: 'insert', table, rows: rows.length, rowsAffected },
			pairedItem: items.map((_item, index) => ({ item: index })),
		},
	];
};
