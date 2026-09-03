import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { vi } from 'vitest';

import type { FabricSqlCredentials, PoolLike, QueryResultLike } from '../../nodes/FabricSql/types';

export const testNode: INode = {
	id: 'n1',
	name: 'Fabric SQL',
	type: 'n8n-nodes-fabric-sql.fabricSql',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export const testCredentials: FabricSqlCredentials = {
	server: 'abc.datawarehouse.fabric.microsoft.com',
	database: 'my_lakehouse',
	tenantId: 'tenant-1',
	clientId: 'client-1',
	clientSecret: 'secret-1',
	connectTimeout: 30_000,
	requestTimeout: 30_000,
	allowWriteOperations: false,
};

export const emptyResult: QueryResultLike = { recordsets: [], rowsAffected: [], columns: [] };

export function rowsResult(names: string[], rows: unknown[][]): QueryResultLike {
	return {
		recordsets: [rows],
		rowsAffected: [rows.length],
		columns: [names.map((name, index) => ({ index, name }))],
	};
}

/**
 * Records every statement a handler issues, so tests assert on SQL and bound parameters
 * rather than on a database.
 */
export function recordingPool(...results: QueryResultLike[]) {
	const calls: Array<{ sql: string; parameters: Record<string, unknown> }> = [];
	let call = 0;

	const pool: PoolLike = {
		request() {
			const parameters: Record<string, unknown> = {};

			return {
				arrayRowMode: undefined,
				input(name: string, value: unknown) {
					parameters[name] = value;
					return this;
				},
				async query(sql: string) {
					calls.push({ sql, parameters });
					const result = results[call] ?? results[results.length - 1] ?? emptyResult;
					call += 1;
					return result;
				},
			};
		},
		close: vi.fn(async () => undefined),
	};

	return { pool, calls };
}

export interface ContextOptions {
	parameters?: Record<string, unknown>;
	items?: INodeExecutionData[];
	continueOnFail?: boolean;
}

/**
 * A minimal `IExecuteFunctions`.
 *
 * Only the members the operations actually touch are implemented; the cast keeps the rest of
 * the very large interface out of the tests.
 */
export function executeContext(options: ContextOptions = {}): IExecuteFunctions {
	const parameters = options.parameters ?? {};
	const items = options.items ?? [{ json: {} }];

	return {
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in parameters ? parameters[name] : fallback,
		getInputData: () => items,
		getNode: () => testNode,
		continueOnFail: () => options.continueOnFail ?? false,
		getCredentials: async () => testCredentials,
	} as unknown as IExecuteFunctions;
}
