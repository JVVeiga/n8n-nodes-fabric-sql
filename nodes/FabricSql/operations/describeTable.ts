import { describeTableQuery } from '../core/queryBuilder';
import { toObjects } from '../core/resultMapper';
import { runQuery } from '../transport/connection';
import type { OperationHandler } from '../types';
import { getTableName } from './params';

/**
 * List a table's columns.
 *
 * A name that matches nothing yields no items rather than an error: "this table has no
 * columns visible to me" is an answer, and a workflow branching on the result can handle it
 * without a try/catch.
 */
export const describeTable: OperationHandler = async (ctx, pool, _credentials, itemIndex) => {
	const result = await runQuery(pool, describeTableQuery(getTableName(ctx, itemIndex)));

	return toObjects(result).map((row) => ({
		json: {
			schema: String(row.TABLE_SCHEMA ?? ''),
			table: String(row.TABLE_NAME ?? ''),
			name: String(row.COLUMN_NAME ?? ''),
			position: row.ORDINAL_POSITION ?? null,
			dataType: String(row.DATA_TYPE ?? ''),
			maxLength: row.CHARACTER_MAXIMUM_LENGTH ?? null,
			precision: row.NUMERIC_PRECISION ?? null,
			scale: row.NUMERIC_SCALE ?? null,
			nullable: row.IS_NULLABLE === 'YES',
			default: row.COLUMN_DEFAULT ?? null,
		},
		pairedItem: [{ item: itemIndex }],
	}));
};
