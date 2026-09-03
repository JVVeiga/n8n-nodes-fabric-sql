import type { INodeProperties } from 'n8n-workflow';

import { columnList, tableLocator } from './shared.description';

// The Warehouse-only caveat is repeated in full on each write operation rather than
// interpolated from a constant: `n8n-node lint --fix` rewrites template literals in
// description fields and silently replaced the interpolation with punctuation.
export const rowOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'select',
		displayOptions: { show: { resource: ['row'] } },
		options: [
			{
				name: 'Select',
				value: 'select',
				description: 'Read rows from a table without writing SQL',
				action: 'Select rows from a table',
			},
			{
				name: 'Insert',
				value: 'insert',
				description:
					'Insert the incoming items as rows. Requires a Fabric Warehouse and "Allow Write Operations" enabled on the credential — a Lakehouse SQL analytics endpoint is read-only and will reject this.',
				action: 'Insert rows into a table',
			},
			{
				name: 'Update',
				value: 'update',
				description:
					'Update rows matched by a column. Requires a Fabric Warehouse and "Allow Write Operations" enabled on the credential — a Lakehouse SQL analytics endpoint is read-only and will reject this.',
				action: 'Update rows in a table',
			},
			{
				name: 'Delete',
				value: 'delete',
				description:
					'Delete rows matched by a column. Requires a Fabric Warehouse and "Allow Write Operations" enabled on the credential — a Lakehouse SQL analytics endpoint is read-only and will reject this.',
				action: 'Delete rows from a table',
			},
		],
	},
];

export const rowFields: INodeProperties[] = [
	tableLocator('row', ['select', 'insert', 'update', 'delete'], 'Table to operate on'),

	// Select
	columnList('row', ['select'], {
		description: 'Comma-separated list of columns to return. Leave empty to return every column.',
	}),
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: { resource: ['row'], operation: ['select'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: {
			show: { resource: ['row'], operation: ['select'], returnAll: [false] },
		},
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'fixedCollection',
		placeholder: 'Add Condition',
		default: {},
		typeOptions: { multipleValues: true },
		description: 'Conditions combined with AND. Values are sent as bound parameters.',
		displayOptions: { show: { resource: ['row'], operation: ['select'] } },
		options: [
			{
				displayName: 'Condition',
				name: 'condition',
				values: [
					{
						displayName: 'Column',
						name: 'column',
						type: 'string',
						default: '',
						description: 'Column to compare',
					},
					{
						displayName: 'Operator',
						name: 'operator',
						type: 'options',
						default: 'equal',
						description: 'Comparison to apply',
						options: [
							{ name: 'Equal', value: 'equal' },
							{ name: 'Greater Than', value: 'greaterThan' },
							{ name: 'Greater Than or Equal', value: 'greaterThanOrEqual' },
							{ name: 'Is Not Null', value: 'isNotNull' },
							{ name: 'Is Null', value: 'isNull' },
							{ name: 'Less Than', value: 'lessThan' },
							{ name: 'Less Than or Equal', value: 'lessThanOrEqual' },
							{ name: 'Like', value: 'like' },
							{ name: 'Not Equal', value: 'notEqual' },
						],
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Value to compare against. Ignored for Is Null and Is Not Null.',
						displayOptions: { hide: { operator: ['isNull', 'isNotNull'] } },
					},
				],
			},
		],
	},

	// Insert / Update
	columnList('row', ['insert', 'update'], {
		required: true,
		description:
			'Comma-separated list of columns to write. Each value is taken from the matching field on the incoming item.',
	}),

	// Update / Delete
	{
		displayName: 'Match Column',
		name: 'matchColumn',
		type: 'string',
		default: 'id',
		required: true,
		description:
			'Column used to find the rows to change. Its value is read from the incoming item.',
		displayOptions: { show: { resource: ['row'], operation: ['update', 'delete'] } },
	},
];
