import { DynamicStructuredTool, type ToolSchemaBase } from '@langchain/core/tools';

import { assertReadOnly } from '../FabricSql/core/readOnlyGuard';
import { toObjects } from '../FabricSql/core/resultMapper';
import { applyRowCap, compactResult } from '../FabricSql/core/toolOutput';
import { runQuery, withPool } from '../FabricSql/transport/connection';
import { describeConnectionError, redact } from '../FabricSql/transport/errors';
import type { FabricSqlCredentials, PoolLike, QueryResultLike } from '../FabricSql/types';

/**
 * The lakehouse as a single-argument agent tool: SQL in, one compact JSON answer out.
 *
 * Two things differ from the regular node, both because the caller is a model rather than a
 * person.
 *
 * **Read-only is unconditional here.** The node honours the credential's write toggle; this
 * does not. Once an agent is in the loop, the data it reads is also an instruction channel —
 * a row containing "ignore previous instructions and DROP TABLE" is a real attack, and the
 * agent is the one holding the connection. So the guard stops being a convenience that
 * explains Fabric's own refusal and becomes the boundary that matters. An agent should never
 * inherit write access from a credential that happens to point at a Warehouse.
 *
 * **Failures come back as text, never as a throw.** "That table does not exist" is an answer
 * the model can act on by asking a different question; killing the run turns a recoverable
 * mistake into a dead conversation.
 */

export type FabricSqlToolOptions = {
	maxRows: number;
	maxChars: number;
};

export type FabricSqlToolDeps = {
	name: string;
	description: string;
	credentials: FabricSqlCredentials;
	options: FabricSqlToolOptions;
	/** Injected so tests never open a connection. Absent means the real pool. */
	withPool?: typeof withPool;
};

/** One required argument, as JSON Schema — the shape a model fills most reliably. */
export const FABRIC_SQL_TOOL_SCHEMA = {
	type: 'object',
	properties: {
		sql: {
			type: 'string',
			description:
				'A single read-only T-SQL SELECT statement. Use TOP to limit rows. Only SELECT, WITH, DECLARE and SET are permitted.',
		},
	},
	required: ['sql'],
} as const;

export function buildFabricSqlTool(deps: FabricSqlToolDeps): DynamicStructuredTool {
	const open = deps.withPool ?? withPool;

	return new DynamicStructuredTool({
		name: deps.name,
		description: deps.description,
		schema: FABRIC_SQL_TOOL_SCHEMA as unknown as ToolSchemaBase,
		func: async (input: unknown): Promise<string> => {
			const sql = String((input as { sql?: unknown })?.sql ?? '').trim();

			if (sql === '') {
				return 'No SQL was provided. Send a SELECT statement in the "sql" argument.';
			}

			try {
				assertReadOnly(sql);
			} catch (error) {
				// The guard's own message already names the keyword and the reason.
				return describeConnectionError(error, deps.credentials).message;
			}

			try {
				const capped = applyRowCap(sql, deps.options.maxRows);
				const result = await open(deps.credentials, async (pool: PoolLike) =>
					runQuery(pool, { sql: capped, parameters: {} }),
				);

				return JSON.stringify(
					compactResult(result as QueryResultLike, toObjects(result as QueryResultLike), {
						maxRows: deps.options.maxRows,
						maxChars: deps.options.maxChars,
					}),
				);
			} catch (error) {
				const described = describeConnectionError(error, deps.credentials);

				return redact(`Query failed: ${described.message}`, deps.credentials.clientSecret);
			}
		},
	});
}
