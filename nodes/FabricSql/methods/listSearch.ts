import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

import { listTablesQuery } from '../core/queryBuilder';
import { runQuery, withPool } from '../transport/connection';
import { loadFabricSqlCredentials } from '../transport/credentials';
import { toNodeError } from '../transport/errors';
import { toTableInfo } from '../operations/listTables';

/**
 * Back the Table field's "From List" mode.
 *
 * A failure here is mapped like any other connection failure rather than returning an empty
 * list: an empty dropdown reads as "this lakehouse has no tables", which sends people looking
 * in the wrong place when the real problem is a rejected secret.
 */
export async function searchTables(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const credentials = await loadFabricSqlCredentials(this);

	try {
		const tables = await withPool(credentials, async (pool) =>
			toTableInfo(await runQuery(pool, listTablesQuery())),
		);

		const needle = (filter ?? '').trim().toLowerCase();
		const results = tables
			.filter((table) => needle === '' || table.qualifiedName.toLowerCase().includes(needle))
			.map((table) => ({
				name: table.qualifiedName,
				value: table.qualifiedName,
				description: table.type,
			}));

		return { results };
	} catch (error) {
		throw toNodeError(this.getNode(), error, {
			server: credentials.server,
			database: credentials.database,
			tenantId: credentials.tenantId,
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
		});
	}
}
