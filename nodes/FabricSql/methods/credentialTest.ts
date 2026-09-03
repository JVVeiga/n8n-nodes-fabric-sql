import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { closeQuietly, createPool, normalizeServer } from '../transport/connection';
import { toFabricSqlCredentials } from '../transport/credentials';
import { describeConnectionError, redact } from '../transport/errors';
import type { RequestFn } from '../transport/warmup';
import { warmUpFabricToken } from '../transport/warmup';
import type { WarmupOutcome } from '../types';

/**
 * Verify the credential by actually connecting.
 *
 * A declarative HTTP test cannot check a database login, so this runs the full path: warm the
 * service principal's Fabric token, open a TDS connection, run `SELECT 1`, close.
 *
 * The warm-up is best effort and cannot fail the test on its own — its failure is reported
 * only as extra context when the connection also fails. That is deliberate: the requirement
 * it covers is not in Microsoft's public documentation.
 */
export async function fabricSqlConnectionTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const credentials = toFabricSqlCredentials((credential.data ?? {}) as IDataObject);

	try {
		// Fail on an unusable server value before spending time on a token request.
		normalizeServer(credentials.server);
	} catch (error) {
		return { status: 'Error', message: describeConnectionError(error, credentials).message };
	}

	// `httpRequest` is not part of ICredentialTestFunctions.helpers — it exposes `request`
	// only — so there is nothing to migrate to here. Using Node's global fetch instead would
	// drop HTTP_PROXY support, which n8n's helper honors and this node's users rely on.
	// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
	const request = this.helpers.request as unknown as RequestFn;
	const warmup: WarmupOutcome = await warmUpFabricToken(credentials, request);

	try {
		const pool = await createPool(credentials);

		try {
			await pool.request().query('SELECT 1');
		} finally {
			await closeQuietly(pool);
		}
	} catch (error) {
		const described = describeConnectionError(error, { ...credentials, warmup });
		const message =
			described.description === undefined
				? described.message
				: `${described.message} ${described.description}`;

		return { status: 'Error', message: redact(message, credentials.clientSecret) };
	}

	return { status: 'OK', message: 'Connection successful' };
}
