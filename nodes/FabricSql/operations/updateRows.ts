import type { IDataObject } from 'n8n-workflow';

import { buildUpdate } from '../core/queryBuilder';
import { runQuery } from '../transport/connection';
import type { OperationHandler } from '../types';
import { getColumns, getTableName } from './params';
import { assertWritesAllowed } from './writeGuard';

/**
 * Update the rows matched by one column, item by item.
 *
 * Unlike insert and delete, this cannot be batched: every item carries its own SET values, so
 * each needs its own statement. Per-item also keeps `pairedItem` exact, which matters when a
 * later node needs to know which input produced which result.
 *
 * Warehouse only — a Lakehouse SQL analytics endpoint rejects writes.
 */
export const updateRows: OperationHandler = async (ctx, pool, credentials, itemIndex) => {
	assertWritesAllowed(credentials, 'UPDATE');

	const table = getTableName(ctx, itemIndex);
	const columns = getColumns(ctx, itemIndex);
	const matchColumn = String(ctx.getNodeParameter('matchColumn', itemIndex, 'id'));
	const row = ctx.getInputData()[itemIndex]?.json as IDataObject;

	const built = buildUpdate(table, columns, row ?? {}, matchColumn);
	const result = await runQuery(pool, built);
	const rowsAffected = (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0);

	return [
		{
			json: { operation: 'update', table, matchColumn, rowsAffected },
			pairedItem: [{ item: itemIndex }],
		},
	];
};
