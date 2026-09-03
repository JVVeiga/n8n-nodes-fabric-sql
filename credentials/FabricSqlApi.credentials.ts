import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Service principal credentials for a Microsoft Fabric SQL analytics endpoint.
 *
 * Fabric accepts Microsoft Entra ID authentication only — there is no SQL login to configure.
 * Client ID and Tenant ID are separate fields on purpose: the composite
 * `UID=client_id@tenant_id` form in Microsoft's ODBC examples is an ODBC quirk and does not
 * apply to this driver.
 *
 * The connection is verified by the node's `fabricSqlConnectionTest` method, which opens a
 * real TDS connection — a declarative HTTP test cannot check a database login.
 */
export class FabricSqlApi implements ICredentialType {
	name = 'fabricSqlApi';

	displayName = 'Microsoft Fabric SQL API';

	icon: Icon = {
		light: 'file:icons/fabricSql.svg',
		dark: 'file:icons/fabricSql.dark.svg',
	};

	documentationUrl =
		'https://learn.microsoft.com/en-us/fabric/data-warehouse/entra-id-authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'Server',
			name: 'server',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'abcdefg.datawarehouse.fabric.microsoft.com',
			description:
				'Host name from Lakehouse or Warehouse → Settings → SQL Connection String. Enter the host only — no port and no ODBC connection string.',
		},
		{
			displayName: 'Database',
			name: 'database',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'my_lakehouse',
			description: 'Name of the lakehouse or warehouse to query',
		},
		{
			displayName: 'Tenant ID',
			name: 'tenantId',
			type: 'string',
			default: '',
			required: true,
			placeholder: '00000000-0000-0000-0000-000000000000',
			description: 'Directory (tenant) ID of the app registration',
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			placeholder: '00000000-0000-0000-0000-000000000000',
			description:
				'Application (client) ID of the app registration. Enter the ID on its own — do not append the tenant ID.',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Client secret value of the app registration — the value shown once at creation, not the secret ID',
		},
		{
			displayName: 'Allow Write Operations',
			name: 'allowWriteOperations',
			type: 'boolean',
			default: false,
			description:
				'Whether to enable the Insert, Update and Delete operations. These require a Fabric Warehouse: a Lakehouse SQL analytics endpoint is read-only and rejects writes.',
		},
		{
			displayName: 'Connect Timeout (Ms)',
			name: 'connectTimeout',
			type: 'number',
			default: 30000,
			description: 'How long to wait for the connection to be established',
		},
		{
			displayName: 'Request Timeout (Ms)',
			name: 'requestTimeout',
			type: 'number',
			default: 30000,
			description: 'How long to wait for a query to return',
		},
	];
}
