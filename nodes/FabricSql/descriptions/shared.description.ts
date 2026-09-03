import type { INodeProperties } from 'n8n-workflow';

/**
 * A table picker offering both the live table list and free-text entry.
 *
 * The list needs a working connection, so free-text entry is not a fallback for convenience —
 * it is what keeps the node usable while the credential is still being sorted out, and the
 * only way to reference a table the principal can query but not enumerate.
 */
export function tableLocator(
	resource: string,
	operations: string[],
	description: string,
): INodeProperties {
	return {
		displayName: 'Table',
		name: 'table',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description,
		displayOptions: { show: { resource: [resource], operation: operations } },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: {
					searchListMethod: 'searchTables',
					searchable: true,
				},
			},
			{
				displayName: 'By Name',
				name: 'name',
				type: 'string',
				placeholder: 'e.g. dbo.orders',
			},
		],
	};
}

/** A comma-separated column list, used wherever the user names columns explicitly. */
export function columnList(
	resource: string,
	operations: string[],
	overrides: Partial<INodeProperties> = {},
): INodeProperties {
	return {
		displayName: 'Columns',
		name: 'columns',
		type: 'string',
		default: '',
		// Deliberately not "id": the lint rule for miscased identifiers rewrites it to "ID",
		// which is wrong for a column-name example.
		placeholder: 'e.g. code, name, created_at',
		description: 'Comma-separated list of column names',
		displayOptions: { show: { resource: [resource], operation: operations } },
		...overrides,
	};
}
