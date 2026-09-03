import { describe, expect, it, vi } from 'vitest';

import { InvalidServerError } from '../../nodes/FabricSql/core/errors';
import {
	AGENT_POOL_IDLE_MS,
	FABRIC_SQL_PORT,
	buildConnectionConfig,
	closeQuietly,
	normalizeServer,
	runQuery,
	usePool,
} from '../../nodes/FabricSql/transport/connection';
import type { FabricSqlCredentials, PoolLike, QueryResultLike } from '../../nodes/FabricSql/types';

const credentials: FabricSqlCredentials = {
	server: 'abc123.datawarehouse.fabric.microsoft.com',
	database: 'my_lakehouse',
	tenantId: 'tenant-1',
	clientId: 'client-1',
	clientSecret: 'secret-1',
	connectTimeout: 45_000,
	requestTimeout: 60_000,
	allowWriteOperations: false,
};

const emptyResult: QueryResultLike = { recordsets: [], rowsAffected: [], columns: [] };

function stubPool(result: QueryResultLike = emptyResult) {
	const inputs: Array<[string, unknown]> = [];
	const query = vi.fn(async () => result);
	const request = {
		arrayRowMode: undefined as boolean | null | undefined,
		input(name: string, value: unknown) {
			inputs.push([name, value]);
			return this;
		},
		query,
	};
	const pool: PoolLike = {
		request: () => request,
		close: vi.fn(async () => undefined),
	};

	return { pool, request, query, inputs };
}

describe('normalizeServer', () => {
	it('passes a bare host through', () => {
		expect(normalizeServer('abc.datawarehouse.fabric.microsoft.com')).toBe(
			'abc.datawarehouse.fabric.microsoft.com',
		);
	});

	it('trims whitespace', () => {
		expect(normalizeServer('  abc.fabric.microsoft.com  ')).toBe('abc.fabric.microsoft.com');
	});

	it('strips the ODBC tcp: prefix', () => {
		expect(normalizeServer('tcp:abc.fabric.microsoft.com')).toBe('abc.fabric.microsoft.com');
	});

	it('strips a comma-separated port', () => {
		expect(normalizeServer('abc.fabric.microsoft.com,1433')).toBe('abc.fabric.microsoft.com');
	});

	it('strips a colon-separated port', () => {
		expect(normalizeServer('abc.fabric.microsoft.com:1433')).toBe('abc.fabric.microsoft.com');
	});

	it('strips both prefix and port', () => {
		expect(normalizeServer('tcp:abc.fabric.microsoft.com,1433')).toBe('abc.fabric.microsoft.com');
	});

	it('lowercases the host', () => {
		expect(normalizeServer('ABC.Fabric.Microsoft.COM')).toBe('abc.fabric.microsoft.com');
	});

	it('strips a trailing dot', () => {
		expect(normalizeServer('abc.fabric.microsoft.com.')).toBe('abc.fabric.microsoft.com');
	});

	it('rejects an empty server', () => {
		expect(() => normalizeServer('   ')).toThrow(InvalidServerError);
	});

	it('rejects a full ODBC connection string', () => {
		expect(() =>
			normalizeServer('DRIVER={ODBC Driver 18 for SQL Server};SERVER=abc.fabric.com'),
		).toThrow(/only the host name/);
	});

	it('rejects a URL', () => {
		expect(() => normalizeServer('https://abc.fabric.microsoft.com')).toThrow(/only the host name/);
	});

	it('rejects a lone semicolon-terminated value', () => {
		expect(() => normalizeServer('abc.fabric.microsoft.com;')).toThrow(InvalidServerError);
	});
});

describe('buildConnectionConfig', () => {
	it('authenticates as a service principal with the three ids', () => {
		const config = buildConnectionConfig(credentials);

		expect(config.authentication).toEqual({
			type: 'azure-active-directory-service-principal-secret',
			options: {
				clientId: 'client-1',
				clientSecret: 'secret-1',
				tenantId: 'tenant-1',
			},
		});
	});

	it('targets port 1433', () => {
		expect(buildConnectionConfig(credentials).port).toBe(FABRIC_SQL_PORT);
		expect(FABRIC_SQL_PORT).toBe(1433);
	});

	it('requires TLS and validates the certificate', () => {
		const config = buildConnectionConfig(credentials);

		expect(config.options?.encrypt).toBe(true);
		expect(config.options?.trustServerCertificate).toBe(false);
	});

	it('normalizes the server it was given', () => {
		expect(
			buildConnectionConfig({ ...credentials, server: 'tcp:ABC.fabric.microsoft.com,1433' }).server,
		).toBe('abc.fabric.microsoft.com');
	});

	it('trims the database and the ids', () => {
		const config = buildConnectionConfig({
			...credentials,
			database: '  lake  ',
			clientId: ' client-1 ',
			tenantId: ' tenant-1 ',
		});

		expect(config.database).toBe('lake');
		expect(config.authentication).toMatchObject({
			options: { clientId: 'client-1', tenantId: 'tenant-1' },
		});
	});

	it('does not trim the secret, which may legitimately end in whitespace', () => {
		expect(
			buildConnectionConfig({ ...credentials, clientSecret: 'secret ' }).authentication,
		).toMatchObject({ options: { clientSecret: 'secret ' } });
	});

	it('carries the configured timeouts', () => {
		const config = buildConnectionConfig(credentials);

		expect(config.connectionTimeout).toBe(45_000);
		expect(config.requestTimeout).toBe(60_000);
	});

	it('falls back to 30s timeouts when unset', () => {
		const config = buildConnectionConfig({
			...credentials,
			connectTimeout: 0,
			requestTimeout: 0,
		});

		expect(config.connectionTimeout).toBe(30_000);
		expect(config.requestTimeout).toBe(30_000);
	});

	it('holds a single connection, since a pool never outlives an execution', () => {
		expect(buildConnectionConfig(credentials).pool).toMatchObject({ max: 1, min: 0 });
	});

	it('enables arrayRowMode so duplicate column names survive', () => {
		expect(buildConnectionConfig(credentials).arrayRowMode).toBe(true);
	});

	it('drops an idle connection after 30s in a workflow', () => {
		expect(buildConnectionConfig(credentials).pool).toMatchObject({
			idleTimeoutMillis: 30_000,
		});
	});

	it('holds an idle connection far longer when told to, for an agent conversation', () => {
		// The gaps between an agent's questions are however long the model takes to think, and
		// at the workflow default the socket would be dropped mid-turn.
		const config = buildConnectionConfig(credentials, {
			idleTimeoutMillis: AGENT_POOL_IDLE_MS,
		});

		expect(config.pool).toMatchObject({ idleTimeoutMillis: AGENT_POOL_IDLE_MS });
		expect(AGENT_POOL_IDLE_MS).toBeGreaterThan(30_000);
	});
});

describe('runQuery', () => {
	it('binds every parameter and runs the statement', async () => {
		const { pool, query, inputs } = stubPool();

		await runQuery(pool, {
			sql: 'SELECT * FROM t WHERE a = @param0 AND b = @param1',
			parameters: { param0: 1, param1: 'x' },
		});

		expect(inputs).toEqual([
			['param0', 1],
			['param1', 'x'],
		]);
		expect(query).toHaveBeenCalledWith('SELECT * FROM t WHERE a = @param0 AND b = @param1');
	});

	it('binds nothing when there are no parameters', async () => {
		const { pool, inputs } = stubPool();

		await runQuery(pool, { sql: 'SELECT 1', parameters: {} });

		expect(inputs).toEqual([]);
	});

	it('turns undefined into null, which the driver can type', async () => {
		const { pool, inputs } = stubPool();

		await runQuery(pool, { sql: 'SELECT @a', parameters: { a: undefined } });

		expect(inputs).toEqual([['a', null]]);
	});

	it('preserves an explicit null', async () => {
		const { pool, inputs } = stubPool();

		await runQuery(pool, { sql: 'SELECT @a', parameters: { a: null } });

		expect(inputs).toEqual([['a', null]]);
	});

	it('requests array rows', async () => {
		const { pool, request } = stubPool();

		await runQuery(pool, { sql: 'SELECT 1', parameters: {} });

		expect(request.arrayRowMode).toBe(true);
	});

	it('returns the driver result unchanged', async () => {
		const result: QueryResultLike = {
			recordsets: [[[1]]],
			rowsAffected: [1],
			columns: [[{ index: 0, name: 'n' }]],
		};
		const { pool } = stubPool(result);

		await expect(runQuery(pool, { sql: 'SELECT 1', parameters: {} })).resolves.toBe(result);
	});
});

describe('usePool', () => {
	it('returns the callback result and closes the pool', async () => {
		const { pool } = stubPool();

		await expect(usePool(pool, async () => 'done')).resolves.toBe('done');
		expect(pool.close).toHaveBeenCalledOnce();
	});

	it('closes the pool even when the callback throws', async () => {
		const { pool } = stubPool();

		await expect(
			usePool(pool, async () => {
				throw new Error('query failed');
			}),
		).rejects.toThrow('query failed');
		expect(pool.close).toHaveBeenCalledOnce();
	});

	it('lets the callback error through even if closing also fails', async () => {
		const pool: PoolLike = {
			request: () => {
				throw new Error('unused');
			},
			close: vi.fn(async () => {
				throw new Error('close failed');
			}),
		};

		await expect(
			usePool(pool, async () => {
				throw new Error('query failed');
			}),
		).rejects.toThrow('query failed');
	});
});

describe('closeQuietly', () => {
	it('closes the pool', async () => {
		const close = vi.fn(async () => undefined);

		await closeQuietly({ close });

		expect(close).toHaveBeenCalledOnce();
	});

	it('swallows a close failure so it cannot mask the real error', async () => {
		const close = vi.fn(async () => {
			throw new Error('already closed');
		});

		await expect(closeQuietly({ close })).resolves.toBeUndefined();
	});
});
