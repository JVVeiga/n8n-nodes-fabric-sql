import type { INodeProperties } from 'n8n-workflow';

import { tableLocator } from './shared.description';

export const schemaOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'listTables',
		displayOptions: { show: { resource: ['schema'] } },
		options: [
			{
				name: 'List Tables',
				value: 'listTables',
				description: 'List the tables and views visible to the service principal',
				action: 'List tables',
			},
			{
				name: 'Describe Table',
				value: 'describeTable',
				description: "List a table's columns with their types and nullability",
				action: 'Describe a table',
			},
		],
	},
];

export const schemaFields: INodeProperties[] = [
	tableLocator('schema', ['describeTable'], 'Table whose columns you want to inspect'),
];
