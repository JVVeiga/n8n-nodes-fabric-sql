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
import { withPool } from './transport/connection';
import { loadFabricSqlCredentials } from './transport/credentials';
import { describeConnectionError, redact, toNodeError } from './transport/errors';

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
		const operation = this.getNodeParameter('operation', 0) as string;
		const handler = resolveOperation(resource, operation);

		if (handler === undefined) {
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the resource "${resource}".`,
			);
		}

		const credentials = await loadFabricSqlCredentials(this);
		const returnData: INodeExecutionData[] = [];

		await withPool(credentials, async (pool) => {
			for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
				try {
					returnData.push(...(await handler(this, pool, credentials, itemIndex)));
				} catch (error) {
					if (!this.continueOnFail()) {
						throw toNodeError(this.getNode(), error, credentials, itemIndex);
					}

					const { message } = describeConnectionError(error, credentials);

					returnData.push({
						json: { error: redact(message, credentials.clientSecret) },
						pairedItem: { item: itemIndex },
					});
				}
			}
		});

		return [returnData];
	}
}
