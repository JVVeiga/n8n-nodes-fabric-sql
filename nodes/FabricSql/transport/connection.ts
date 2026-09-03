import mssql from 'mssql';

import { InvalidServerError } from '../core/errors';
import type {
	BuiltQuery,
	FabricSqlCredentials,
	PoolLike,
	QueryResultLike,
	RequestLike,
} from '../types';

/** Fabric SQL analytics endpoints listen on 1433 only; there is nothing to configure. */
export const FABRIC_SQL_PORT = 1433;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Reduce whatever the user pasted into the bare hostname the driver needs.
 *
 * The connection details Fabric shows are ODBC-shaped, so the Server field regularly arrives
 * as `tcp:host,1433`, as `host:1433`, or as an entire `DRIVER={...};SERVER=...` string. The
 * first two are unambiguous and get cleaned up; the third is rejected, because guessing which
 * of its fields was meant would be worse than asking.
 */
export function normalizeServer(raw: string): string {
	const trimmed = (raw ?? '').trim();

	if (trimmed === '') {
		throw new InvalidServerError('Server is empty.');
	}

	if (trimmed.includes('=') || trimmed.includes(';') || trimmed.includes('/')) {
		throw new InvalidServerError(
			'Enter only the host name, for example ' +
				'abcdefg.datawarehouse.fabric.microsoft.com — not a full ODBC connection string or URL.',
		);
	}

	const withoutPrefix = trimmed.replace(/^tcp:/i, '');
	const withoutPort = withoutPrefix.replace(/[,:]\d+$/, '');
	const host = withoutPort.replace(/\.+$/, '').toLowerCase();

	if (host === '') {
		throw new InvalidServerError('Server is empty.');
	}

	return host;
}

/**
 * Build the driver configuration.
 *
 * Pure, so the exact shape can be asserted in tests — which matters because most of these
 * values are the difference between connecting and a silent timeout.
 *
 * `trustServerCertificate` is fixed at `false` and deliberately not exposed: the endpoint is
 * Microsoft-hosted with a valid certificate, so turning validation off would only ever hide a
 * man-in-the-middle. `arrayRowMode` is on so duplicate column names survive (see
 * `core/resultMapper`).
 */
export function buildConnectionConfig(credentials: FabricSqlCredentials): mssql.config {
	return {
		server: normalizeServer(credentials.server),
		database: credentials.database.trim(),
		port: FABRIC_SQL_PORT,
		authentication: {
			type: 'azure-active-directory-service-principal-secret',
			options: {
				clientId: credentials.clientId.trim(),
				clientSecret: credentials.clientSecret,
				tenantId: credentials.tenantId.trim(),
			},
		},
		options: {
			encrypt: true,
			trustServerCertificate: false,
		},
		pool: {
			max: 1,
			min: 0,
			idleTimeoutMillis: 30_000,
		},
		connectionTimeout: credentials.connectTimeout || DEFAULT_TIMEOUT_MS,
		requestTimeout: credentials.requestTimeout || DEFAULT_TIMEOUT_MS,
		arrayRowMode: true,
	};
}

export async function createPool(
	credentials: FabricSqlCredentials,
): Promise<mssql.ConnectionPool> {
	const pool = new mssql.ConnectionPool(buildConnectionConfig(credentials));

	await pool.connect();

	return pool;
}

/**
 * Run one statement with its values bound as parameters.
 *
 * `undefined` becomes `null` because the driver infers a parameter's type from its value and
 * cannot infer anything from `undefined`; a workflow that omits a field means SQL NULL.
 */
export async function runQuery(pool: PoolLike, built: BuiltQuery): Promise<QueryResultLike> {
	const request = pool.request();

	request.arrayRowMode = true;

	for (const [name, value] of Object.entries(built.parameters)) {
		request.input(name, value === undefined ? null : value);
	}

	return await request.query(built.sql);
}

/**
 * Open one pool, hand it to `fn`, and always close it.
 *
 * n8n executions are isolated, so a pool that outlived one would hold a socket open against
 * a credential that may since have been rotated. A failure while closing is swallowed so it
 * cannot mask whatever `fn` was actually reporting.
 */
export async function withPool<T>(
	credentials: FabricSqlCredentials,
	fn: (pool: PoolLike) => Promise<T>,
): Promise<T> {
	return await usePool(asPool(await createPool(credentials)), fn);
}

/**
 * The lifecycle half of `withPool`, separated so it can be exercised with a stub pool.
 */
export async function usePool<T>(
	pool: PoolLike,
	fn: (pool: PoolLike) => Promise<T>,
): Promise<T> {
	try {
		return await fn(pool);
	} finally {
		await closeQuietly(pool);
	}
}

/**
 * Present the driver pool as the app-level `PoolLike` contract.
 *
 * `@types/mssql` does not model `arrayRowMode`: its `IResult` has no `columns`, even though
 * the driver populates it (mssql documents this under "Handling Duplicate Column Names").
 * The resulting cast is confined to this one function so nothing downstream has to know.
 */
export function asPool(pool: mssql.ConnectionPool): PoolLike {
	return {
		request: () => pool.request() as unknown as RequestLike,
		close: async () => await pool.close(),
	};
}

export async function closeQuietly(pool: Pick<PoolLike, 'close'>): Promise<void> {
	try {
		await pool.close();
	} catch {
		// A pool that will not close cleanly is not worth reporting over the original failure.
	}
}
