import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { describeConnectionError, redact, toNodeError } from '../transport/errors';
import type { FabricSqlCredentials, Operation, PoolLike } from '../types';

/**
 * Feed the items to an operation and collect what comes back.
 *
 * Lives here rather than in the node so that error handling — which is the part with actual
 * behavior — is unit-testable without constructing a node, and so the node file stays wiring.
 */
export async function runOperation(
	ctx: IExecuteFunctions,
	pool: PoolLike,
	credentials: FabricSqlCredentials,
	operation: Operation,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	if (operation.kind === 'batch') {
		try {
			return await operation.run(ctx, pool, credentials, items);
		} catch (error) {
			if (!ctx.continueOnFail()) {
				throw toNodeError(ctx.getNode(), error, credentials);
			}

			// A batch either happened or it did not, so the failure belongs to every item.
			return [
				{
					json: { error: errorText(error, credentials) },
					pairedItem: items.map((_item, index) => ({ item: index })),
				},
			];
		}
	}

	const collected: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
		try {
			collected.push(...(await operation.run(ctx, pool, credentials, itemIndex)));
		} catch (error) {
			if (!ctx.continueOnFail()) {
				throw toNodeError(ctx.getNode(), error, credentials, itemIndex);
			}

			collected.push({
				json: { error: errorText(error, credentials) },
				pairedItem: { item: itemIndex },
			});
		}
	}

	return collected;
}

function errorText(error: unknown, credentials: FabricSqlCredentials): string {
	return redact(describeConnectionError(error, credentials).message, credentials.clientSecret);
}
