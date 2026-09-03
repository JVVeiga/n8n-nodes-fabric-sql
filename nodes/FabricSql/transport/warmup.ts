import { ClientSecretCredential } from '@azure/identity';

import type { FabricSqlCredentials, WarmupOutcome } from '../types';

export const FABRIC_API_SCOPE = 'https://api.fabric.microsoft.com/.default';
export const FABRIC_WORKSPACES_URL = 'https://api.fabric.microsoft.com/v1/workspaces';

export interface WarmupRequestOptions {
	method: 'GET';
	uri: string;
	headers: Record<string, string>;
	json: true;
}

/** Shaped after n8n's `helpers.request`, so the node's proxy settings apply to this call. */
export type RequestFn = (options: WarmupRequestOptions) => Promise<unknown>;

export type TokenProvider = (credentials: FabricSqlCredentials) => Promise<string>;

/**
 * Call the Fabric REST API once, to initialize a service principal's internal Fabric token.
 *
 * A newly created principal is reported to need at least one Fabric API call before the SQL
 * endpoint will accept it. That requirement is not in Microsoft's public documentation, so
 * this is best effort by design: it never throws, and a failure here is only surfaced if the
 * subsequent TDS connection also fails. Treating an undocumented step as mandatory would
 * break every tenant where it turns out to be unnecessary.
 *
 * Only the credential test calls this — a workflow execution does no HTTP.
 */
export async function warmUpFabricToken(
	credentials: FabricSqlCredentials,
	request: RequestFn,
	getToken: TokenProvider = acquireFabricApiToken,
): Promise<WarmupOutcome> {
	let token: string;

	try {
		token = await getToken(credentials);
	} catch (error) {
		return { ok: false, detail: `could not acquire a Fabric API token (${detailOf(error)})` };
	}

	try {
		await request({
			method: 'GET',
			uri: FABRIC_WORKSPACES_URL,
			headers: { Authorization: `Bearer ${token}` },
			json: true,
		});
	} catch (error) {
		return { ok: false, detail: detailOf(error) };
	}

	return { ok: true };
}

export async function acquireFabricApiToken(credentials: FabricSqlCredentials): Promise<string> {
	const credential = new ClientSecretCredential(
		credentials.tenantId.trim(),
		credentials.clientId.trim(),
		credentials.clientSecret,
	);

	const token = await credential.getToken(FABRIC_API_SCOPE);

	if (!token?.token) {
		throw new Error('Entra ID returned no access token for the Fabric API scope.');
	}

	return token.token;
}

function detailOf(error: unknown): string {
	if (error === null || error === undefined) {
		return 'unknown error';
	}

	if (typeof error === 'string') {
		return error;
	}

	if (typeof error !== 'object') {
		return String(error);
	}

	const status = 'statusCode' in error ? (error as { statusCode: unknown }).statusCode : undefined;
	const message =
		'message' in error ? String((error as { message: unknown }).message) : 'unknown error';

	return status === undefined ? message : `${String(status)} ${message}`;
}
