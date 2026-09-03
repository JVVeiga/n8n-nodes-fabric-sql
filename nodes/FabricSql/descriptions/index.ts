import type { INodeProperties } from 'n8n-workflow';

import { queryFields, queryOperations } from './query.description';
import { rowFields, rowOperations } from './row.description';
import { schemaFields, schemaOperations } from './schema.description';

const resource: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	default: 'query',
	options: [
		{ name: 'Query', value: 'query', description: 'Run SQL directly' },
		{ name: 'Row', value: 'row', description: 'Read or write table rows without SQL' },
		{ name: 'Schema', value: 'schema', description: 'Discover tables and columns' },
	],
};

/**
 * Every node parameter, assembled from one file per resource.
 *
 * These files hold data only — no logic, no SQL, no error strings — so the UI surface can be
 * reviewed on its own and an operation's behavior lives entirely in `operations/`.
 */
export const fabricSqlProperties: INodeProperties[] = [
	resource,
	...queryOperations,
	...rowOperations,
	...schemaOperations,
	...queryFields,
	...rowFields,
	...schemaFields,
];
