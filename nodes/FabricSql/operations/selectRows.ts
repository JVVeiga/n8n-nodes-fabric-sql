import { buildSelect } from '../core/queryBuilder';
import { mapRecordsets } from '../core/resultMapper';
import { runQuery } from '../transport/connection';
import type { OperationHandler } from '../types';
import { getColumns, getFilters, getTableName } from './params';

/** Read rows from one table without writing SQL. */
export const selectRows: OperationHandler = async (ctx, pool, _credentials, itemIndex) => {
	const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) as boolean;

	const built = buildSelect({
		table: getTableName(ctx, itemIndex),
		columns: getColumns(ctx, itemIndex),
		limit: returnAll ? undefined : (ctx.getNodeParameter('limit', itemIndex, 50) as number),
		where: getFilters(ctx, itemIndex),
	});

	return mapRecordsets(await runQuery(pool, built), itemIndex);
};
