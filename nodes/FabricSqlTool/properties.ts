import type { INodeProperties } from 'n8n-workflow';

/**
 * Parameters for the Fabric SQL Tool sub-node.
 *
 * Split out the way `FabricSql`'s are, and for the same reason: data in one file, wiring in
 * the node file. The node's own `description` object stays inline there, because the
 * community-node lint reads `icon` and the file name off the class statically and cannot
 * follow an imported description.
 */
export const fabricSqlToolProperties: INodeProperties[] = [
	{
		displayName: 'Tool Description',
		name: 'toolDescription',
		type: 'string',
		typeOptions: { rows: 4 },
		default:
			'Runs a read-only SQL query against the Microsoft Fabric lakehouse and returns the rows as JSON. Use it to look up facts in the data rather than guessing. Only SELECT is allowed.',
		description:
			'What the Agent reads to decide when to call this tool. Describe what the data is about — the table and column names are appended automatically when Include Schema is on.',
	},
	{
		displayName: 'Include Schema in Description',
		name: 'includeSchema',
		type: 'boolean',
		default: true,
		description:
			'Whether to read the table and column names once and append them to the tool description. Costs one query per agent run, and saves the Agent from inventing table names.',
	},
	{
		displayName: 'Table Filter',
		name: 'tableFilter',
		type: 'string',
		default: '',
		placeholder: 'e.g. bug_%',
		description:
			'SQL LIKE pattern limiting which tables appear in the schema. Leave empty for all of them — worth setting on a large lakehouse, since the whole list goes into every Agent prompt.',
		displayOptions: { show: { includeSchema: [true] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Max Response Characters',
				name: 'maxChars',
				type: 'number',
				default: 8000,
				typeOptions: { minValue: 500 },
				description:
					'Character budget for one answer. Rows are dropped to fit, and the answer says it was cut.',
			},
			{
				displayName: 'Max Rows',
				name: 'maxRows',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 1 },
				description:
					'Row cap for one query. Applied as TOP when the statement allows it, so the server does not materialise more than this, and enforced again when reading.',
			},
			{
				displayName: 'Max Schema Characters',
				name: 'maxSchemaChars',
				type: 'number',
				default: 4000,
				typeOptions: { minValue: 200 },
				description:
					'Character budget for the schema appended to the tool description. Tables past it are omitted with a note.',
			},
		],
	},
];
