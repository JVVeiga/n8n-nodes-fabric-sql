import { listTablesQuery } from '../core/queryBuilder';
import { toObjects } from '../core/resultMapper';
import { runQuery } from '../transport/connection';
import type { OperationHandler, QueryResultLike } from '../types';

export interface TableInfo {
	schema: string;
	name: string;
	qualifiedName: string;
	type: string;
}

/**
 * Reshape `INFORMATION_SCHEMA.TABLES` rows into something a workflow can use directly.
 *
 * `qualifiedName` is included because it is what every other operation in this node wants as
 * its Table value — without it, a workflow has to concatenate two fields by hand.
 */
export function toTableInfo(result: QueryResultLike): TableInfo[] {
	return toObjects(result).map((row) => {
		const schema = String(row.TABLE_SCHEMA ?? '');
		const name = String(row.TABLE_NAME ?? '');

		return {
			schema,
			name,
			qualifiedName: schema === '' ? name : `${schema}.${name}`,
			type: String(row.TABLE_TYPE ?? ''),
		};
	});
}

/** List the tables and views the service principal can see. */
export const listTables: OperationHandler = async (_ctx, pool, _credentials, itemIndex) => {
	const tables = toTableInfo(await runQuery(pool, listTablesQuery()));

	return tables.map((table) => ({
		json: { ...table },
		pairedItem: [{ item: itemIndex }],
	}));
};
