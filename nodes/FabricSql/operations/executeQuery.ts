import { EmptySqlError } from '../core/errors';
import { bindPlaceholders } from '../core/placeholders';
import { assertReadOnly } from '../core/readOnlyGuard';
import { mapRecordsets } from '../core/resultMapper';
import { runQuery } from '../transport/connection';
import type { OperationHandler } from '../types';
import { getQueryParameters } from './params';

/**
 * Run a raw SQL statement.
 *
 * The read-only guard runs before anything is bound, so a write against a Lakehouse endpoint
 * fails with an explanation instead of a driver rejection. It is skipped when the credential
 * opts into writes — at which point the server is the only authority, which is the correct
 * arrangement anyway.
 */
export const executeQuery: OperationHandler = async (ctx, pool, credentials, itemIndex) => {
	const query = ctx.getNodeParameter('query', itemIndex, '') as string;

	if (credentials.allowWriteOperations) {
		if (query.trim() === '') {
			throw new EmptySqlError();
		}
	} else {
		assertReadOnly(query);
	}

	const built = bindPlaceholders(query, getQueryParameters(ctx, itemIndex));
	const result = await runQuery(pool, built);

	return mapRecordsets(result, itemIndex);
};
