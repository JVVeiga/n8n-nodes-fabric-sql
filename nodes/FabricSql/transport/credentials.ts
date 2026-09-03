import type { IDataObject } from 'n8n-workflow';

import type { FabricSqlCredentials } from '../types';

export const CREDENTIAL_NAME = 'fabricSqlApi';

const DEFAULT_TIMEOUT_MS = 30_000;

interface CredentialReader {
	getCredentials(name: string): Promise<IDataObject>;
}

/**
 * Coerce a decrypted credential into the typed shape the rest of the node uses.
 *
 * Stored credentials are untyped and can predate a field: an older record has no
 * `allowWriteOperations` and no timeouts. Defaults are applied here, once, rather than at
 * every use site.
 */
export function toFabricSqlCredentials(raw: IDataObject): FabricSqlCredentials {
	return {
		server: String(raw?.server ?? ''),
		database: String(raw?.database ?? ''),
		tenantId: String(raw?.tenantId ?? ''),
		clientId: String(raw?.clientId ?? ''),
		clientSecret: String(raw?.clientSecret ?? ''),
		connectTimeout: Number(raw?.connectTimeout) || DEFAULT_TIMEOUT_MS,
		requestTimeout: Number(raw?.requestTimeout) || DEFAULT_TIMEOUT_MS,
		allowWriteOperations: raw?.allowWriteOperations === true,
	};
}

export async function loadFabricSqlCredentials(
	ctx: CredentialReader,
): Promise<FabricSqlCredentials> {
	return toFabricSqlCredentials(await ctx.getCredentials(CREDENTIAL_NAME));
}
