import type { IDataObject } from 'n8n-workflow';

import { buildDelete } from '../core/queryBuilder';
import { runQuery } from '../transport/connection';
import type { BatchOperationHandler } from '../types';
import { getTableName } from './params';
import { assertWritesAllowed } from './writeGuard';

/**
 * Delete the rows whose match column appears in the incoming items.
 *
 * Batched into `IN (...)` lists sized to the 2100-parameter limit, so a large delete is a few
 * statements rather than one per item.
 *
 * An item with no value for the match column is skipped rather than deleted as NULL — a
 * missing key is a gap in the input, not an instruction to match rows where the key is null.
 *
 * Warehouse only — a Lakehouse SQL analytics endpoint rejects writes.
 */
export const deleteRows: BatchOperationHandler = async (ctx, pool, credentials, items) => {
	assertWritesAllowed(credentials, 'DELETE');

	const table = getTableName(ctx, 0);
	const matchColumn = String(ctx.getNodeParameter('matchColumn', 0, 'id'));

	const values = items
		.map((item) => (item.json as IDataObject)?.[matchColumn])
		.filter((value) => value !== undefined && value !== null);

	let rowsAffected = 0;

	for (const built of buildDelete(table, matchColumn, values)) {
		const result = await runQuery(pool, built);
		rowsAffected += (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0);
	}

	return [
		{
			json: {
				operation: 'delete',
				table,
				matchColumn,
				matched: values.length,
				skipped: items.length - values.length,
				rowsAffected,
			},
			pairedItem: items.map((_item, index) => ({ item: index })),
		},
	];
};
