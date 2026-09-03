import type { INodeProperties } from 'n8n-workflow';

export const queryOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'executeQuery',
		displayOptions: { show: { resource: ['query'] } },
		options: [
			{
				name: 'Execute Query',
				value: 'executeQuery',
				description: 'Run a SQL statement and return its rows',
				action: 'Execute a SQL query',
			},
		],
	},
];

export const queryFields: INodeProperties[] = [
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		typeOptions: {
			editor: 'sqlEditor',
			sqlDialect: 'MSSQL',
			rows: 6,
		},
		placeholder: 'SELECT TOP 10 * FROM dbo.orders WHERE created_at > ?',
		description:
			'SQL to run. Use ? for each value you want to pass in, and add the values under Query Parameters below — they are sent as bound parameters, never pasted into the SQL.',
		displayOptions: { show: { resource: ['query'], operation: ['executeQuery'] } },
	},
	{
		displayName: 'Query Parameters',
		name: 'queryParameters',
		type: 'fixedCollection',
		placeholder: 'Add Parameter',
		default: {},
		typeOptions: { multipleValues: true, sortable: true },
		description:
			'Values for the ? placeholders in the query, in order. A plain entry is sent as text; use an expression such as {{ 42 }} to send a number, boolean or null.',
		displayOptions: { show: { resource: ['query'], operation: ['executeQuery'] } },
		options: [
			{
				displayName: 'Parameter',
				name: 'parameter',
				values: [
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Value to bind to the next ? in the query',
					},
				],
			},
		],
	},
];
