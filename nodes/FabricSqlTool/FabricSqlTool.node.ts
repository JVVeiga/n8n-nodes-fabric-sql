import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { fabricSqlConnectionTest } from '../FabricSql/methods/credentialTest';
import { QUERY_COST_GUIDANCE, formatSchemaDigest } from '../FabricSql/core/toolOutput';
import { toObjects } from '../FabricSql/core/resultMapper';
import {
	AGENT_POOL_IDLE_MS,
	asPool,
	closeQuietly,
	createPool,
	runQuery,
} from '../FabricSql/transport/connection';
import { loadFabricSqlCredentials } from '../FabricSql/transport/credentials';
import { toNodeError } from '../FabricSql/transport/errors';
import type { FabricSqlCredentials, PoolLike } from '../FabricSql/types';
import { fabricSqlToolProperties } from './properties';
import { toolRunLog } from './toolRunLog';
import { buildFabricSqlTool } from './tool';

type ToolNodeOptions = {
	maxRows?: number;
	maxChars?: number;
	maxSchemaChars?: number;
};

export type SupplyFabricSqlToolDeps = {
	/** Injected so a test never opens a connection. Absent means the real pool. */
	openPool?: (credentials: FabricSqlCredentials) => Promise<PoolLike>;
};

/**
 * The lakehouse as a purpose-built `ai_tool` sub-node.
 *
 * Separate from `FabricSql` rather than relying on `usableAsTool`, for two things only this
 * shape allows. `supplyData` is async and holds the credential, so the schema can be read
 * *before* the agent starts and written into the tool description — a model that already knows
 * the table names stops inventing them. And it can hold one connection for the whole
 * conversation, instead of paying a TCP connect, a TLS handshake and an Entra ID token
 * exchange for every question the model asks.
 *
 * `usableAsTool` was removed from `FabricSql` when this landed — n8n synthesized a
 * `fabricSqlTool` type from that flag, which is the name this node needs.
 */
export class FabricSqlTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Fabric SQL Tool',
		name: 'fabricSqlTool',
		icon: { light: 'file:fabricSql.svg', dark: 'file:fabricSql.dark.svg' },
		group: ['transform'],
		version: 1,
		// Which slice of the lakehouse this tool exposes, at a glance on the canvas.
		subtitle: '={{ $parameter["tableFilter"] || "all tables" }}',
		description:
			'Give an AI Agent read-only SQL access to a Microsoft Fabric lakehouse or warehouse, with the table schema supplied up front',
		defaults: { name: 'Fabric SQL Tool' },
		inputs: [],
		outputs: [{ type: NodeConnectionTypes.AiTool }],
		outputNames: ['Tool'],
		credentials: [
			{
				name: 'fabricSqlApi',
				required: true,
				testedBy: 'fabricSqlConnectionTest',
			},
		],
		properties: fabricSqlToolProperties,
	};

	methods = {
		credentialTest: { fabricSqlConnectionTest },
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		return await supplyFabricSqlTool(this, {}, itemIndex);
	}
}

export async function supplyFabricSqlTool(
	ctx: ISupplyDataFunctions,
	deps: SupplyFabricSqlToolDeps,
	itemIndex: number,
): Promise<SupplyData> {
	const credentials = await loadFabricSqlCredentials(ctx);
	const options = ctx.getNodeParameter('options', itemIndex, {}) as ToolNodeOptions;
	const toolDescription = String(ctx.getNodeParameter('toolDescription', itemIndex, '')).trim();
	const includeSchema = ctx.getNodeParameter('includeSchema', itemIndex, true) === true;
	const tableFilter = String(ctx.getNodeParameter('tableFilter', itemIndex, '')).trim();

	const open =
		deps.openPool ??
		(async (creds: FabricSqlCredentials) =>
			asPool(await createPool(creds, { idleTimeoutMillis: AGENT_POOL_IDLE_MS })));

	// One pool for the schema read AND every call the agent makes. Failing to open it IS fatal
	// here, unlike a failed schema read: a tool that cannot connect has nothing to offer, and
	// saying so now beats handing the agent a tool that fails on its first use.
	let pool: PoolLike;

	try {
		pool = await open(credentials);
	} catch (error) {
		throw toNodeError(ctx.getNode(), error, credentials, itemIndex);
	}

	const digest = includeSchema
		? await readSchemaDigest(ctx, pool, tableFilter, options.maxSchemaChars ?? 2000)
		: '';

	const tool = buildFabricSqlTool({
		name: toToolName(ctx.getNode().name),
		description: [toolDescription, digest, QUERY_COST_GUIDANCE]
			.filter((part) => part !== '')
			.join('\n\n'),
		credentials,
		pool,
		log: toolRunLog(ctx),
		options: {
			maxRows: Math.max(1, options.maxRows ?? 100),
			maxChars: Math.max(500, options.maxChars ?? 8000),
		},
	});

	// n8n calls this when the execution ends. Without it the pool would outlive the run and
	// hold a socket open against a credential that may since have been rotated.
	return { response: tool, closeFunction: async () => await closeQuietly(pool) };
}

/**
 * Read the table and column names once, for the tool description.
 *
 * Best effort on purpose: a tool that cannot describe the schema is still a working tool, and
 * failing the whole agent run because a metadata query timed out would trade a small loss for
 * a total one. The failure surfaces as a node warning instead, so it is visible without being
 * fatal.
 */
async function readSchemaDigest(
	ctx: ISupplyDataFunctions,
	pool: PoolLike,
	tableFilter: string,
	maxChars: number,
): Promise<string> {
	const parameters: Record<string, unknown> = {};
	let filter = "WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')";

	if (tableFilter !== '') {
		parameters.pattern = tableFilter;
		filter += ' AND TABLE_NAME LIKE @pattern';
	}

	try {
		const result = await runQuery(pool, {
			sql:
				'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE ' +
				`FROM INFORMATION_SCHEMA.COLUMNS ${filter} ` +
				'ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION',
			parameters,
		});

		return formatSchemaDigest(toObjects(result), {
			maxChars,
			...(tableFilter === '' ? {} : { tableFilter }),
		});
	} catch (error) {
		ctx.logger?.warn(
			'Fabric SQL Tool could not read the schema for its description; the tool still works.',
			{ error: error instanceof Error ? error.message : String(error) } as IDataObject,
		);

		return '';
	}
}

/**
 * The node's canvas name, reduced to something a model can call.
 *
 * The name is what the agent writes to invoke the tool, so it has to survive being renamed to
 * "Fabric SQL Tool (bugs)" without producing an unusable identifier.
 */
export function toToolName(nodeName: string): string {
	const slug = nodeName
		.trim()
		.replace(/[^A-Za-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase();

	return slug === '' ? 'fabric_sql' : slug;
}
