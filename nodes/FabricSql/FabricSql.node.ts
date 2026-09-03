import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { fabricSqlProperties } from './descriptions';
import { fabricSqlConnectionTest } from './methods/credentialTest';
import { searchTables } from './methods/listSearch';
import { resolveOperation } from './operations';
import { runOperation } from './operations/run';
import { withPool } from './transport/connection';
import { loadFabricSqlCredentials } from './transport/credentials';

export class FabricSql implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Microsoft Fabric SQL',
		name: 'fabricSql',
		icon: { light: 'file:fabricSql.svg', dark: 'file:fabricSql.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description:
			'Query a Microsoft Fabric SQL analytics endpoint (Lakehouse or Warehouse) with an Entra ID service principal',
		defaults: { name: 'Microsoft Fabric SQL' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				// Spelled out rather than referencing CREDENTIAL_NAME: the community-node lint
				// rule that checks a credential is tested reads this literal statically and
				// cannot follow an imported constant.
				name: 'fabricSqlApi',
				required: true,
				testedBy: 'fabricSqlConnectionTest',
			},
		],
		properties: fabricSqlProperties,
	};

	methods = {
		listSearch: { searchTables },
		credentialTest: { fabricSqlConnectionTest },
	};

	/**
	 * Resolve the operation, open one pool, run every item through it, close the pool.
	 *
	 * All the behavior lives in `operations/`; this stays wiring on purpose. One pool per
	 * execution rather than per item, because opening a TDS connection to Fabric costs a token
	 * exchange and a TLS handshake.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operationName = this.getNodeParameter('operation', 0) as string;
		const operation = resolveOperation(resource, operationName);

		if (operation === undefined) {
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operationName}" is not supported for the resource "${resource}".`,
			);
		}

		const credentials = await loadFabricSqlCredentials(this);

		const returnData = await withPool(credentials, async (pool) =>
			runOperation(this, pool, credentials, operation, items),
		);

		return [returnData];
	}
}
