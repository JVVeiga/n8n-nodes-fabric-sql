import type { ICredentialsDecrypted, ICredentialTestFunctions } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { fabricSqlConnectionTest } from '../../nodes/FabricSql/methods/credentialTest';
import * as connection from '../../nodes/FabricSql/transport/connection';
import * as warmup from '../../nodes/FabricSql/transport/warmup';
import type { WarmupOutcome } from '../../nodes/FabricSql/types';
import { testCredentials } from '../helpers/context';

function testFunctions(request = vi.fn(async () => ({ value: [] }))) {
	return {
		context: {
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			helpers: { request },
		} as unknown as ICredentialTestFunctions,
		request,
	};
}

function credential(overrides: Record<string, unknown> = {}): ICredentialsDecrypted {
	return {
		id: 'c1',
		name: 'Fabric',
		type: 'fabricSqlApi',
		data: { ...testCredentials, ...overrides },
	} as ICredentialsDecrypted;
}

/** A pool whose `SELECT 1` succeeds, so the happy path needs no database. */
function workingPool() {
	const close = vi.fn(async () => undefined);
	const query = vi.fn(async () => ({ recordsets: [[[1]]], rowsAffected: [1], columns: [] }));

	return {
		close,
		query,
		pool: {
			request: () => ({ query }),
			close,
		},
	};
}

function stubPool(pool: unknown) {
	// createPool returns a real mssql.ConnectionPool; the test only needs request() and close().
	return vi
		.spyOn(connection, 'createPool')
		.mockImplementation(async () => pool as Awaited<ReturnType<typeof connection.createPool>>);
}

function stubWarmup(outcome: WarmupOutcome = { ok: true }) {
	return vi.spyOn(warmup, 'warmUpFabricToken').mockResolvedValue(outcome);
}

describe('fabricSqlConnectionTest — success', () => {
	it('warms the token, runs SELECT 1 and closes the pool', async () => {
		const { pool, query, close } = workingPool();
		const poolSpy = stubPool(pool);
		const warmupSpy = stubWarmup();
		const { context } = testFunctions();

		const result = await fabricSqlConnectionTest.call(context, credential());

		expect(result).toEqual({ status: 'OK', message: 'Connection successful' });
		expect(warmupSpy).toHaveBeenCalledOnce();
		expect(query).toHaveBeenCalledWith('SELECT 1');
		expect(close).toHaveBeenCalledOnce();
		poolSpy.mockRestore();
		warmupSpy.mockRestore();
	});

	it('succeeds even when the warm-up failed', async () => {
		const { pool } = workingPool();
		const poolSpy = stubPool(pool);
		const warmupSpy = stubWarmup({ ok: false, detail: '403 Forbidden' });
		const { context } = testFunctions();

		await expect(fabricSqlConnectionTest.call(context, credential())).resolves.toEqual({
			status: 'OK',
			message: 'Connection successful',
		});
		poolSpy.mockRestore();
		warmupSpy.mockRestore();
	});

	it('passes n8n request helper through to the warm-up', async () => {
		const { pool } = workingPool();
		const poolSpy = stubPool(pool);
		const warmupSpy = stubWarmup();
		const { context, request } = testFunctions();

		await fabricSqlConnectionTest.call(context, credential());

		expect(warmupSpy).toHaveBeenCalledWith(expect.anything(), request);
		poolSpy.mockRestore();
		warmupSpy.mockRestore();
	});
});

describe('fabricSqlConnectionTest — failures', () => {
	async function failWith(error: unknown, warmupOutcome?: WarmupOutcome) {
		const poolSpy = stubPool(undefined);
		poolSpy.mockImplementation(async () => {
			throw error;
		});
		const warmupSpy = stubWarmup(warmupOutcome ?? { ok: true });
		const { context } = testFunctions();

		const result = await fabricSqlConnectionTest.call(context, credential());

		poolSpy.mockRestore();
		warmupSpy.mockRestore();

		return result;
	}

	it('names a rejected client secret', async () => {
		const result = await failWith(new Error('AADSTS7000215: Invalid client secret provided.'));

		expect(result.status).toBe('Error');
		expect(result.message).toContain('Client secret was rejected by Entra ID');
	});

	it('names an application missing from the tenant', async () => {
		const result = await failWith(new Error('AADSTS700016: not found'));

		expect(result.message).toContain('client-1');
		expect(result.message).toContain('tenant-1');
	});

	it('names an unreachable port', async () => {
		const result = await failWith(Object.assign(new Error('nope'), { code: 'ESOCKET' }));

		expect(result.message).toContain('TCP 1433');
	});

	it('names a principal with no workspace access', async () => {
		const result = await failWith(
			new Error("Login failed for user '<token-identified principal>'."),
		);

		expect(result.message).toContain('Service principals can use Fabric APIs');
	});

	it('adds the warm-up failure only once the connection also failed', async () => {
		const result = await failWith(Object.assign(new Error('nope'), { code: 'ESOCKET' }), {
			ok: false,
			detail: '403 Forbidden',
		});

		expect(result.message).toContain('Fabric REST warm-up also failed: 403 Forbidden');
	});

	it('never returns the client secret', async () => {
		const result = await failWith(new Error(`refused PWD=${testCredentials.clientSecret};`));

		expect(result.message).not.toContain(testCredentials.clientSecret);
		expect(result.message).toContain('***');
	});
});

describe('fabricSqlConnectionTest — bad input', () => {
	it('rejects an ODBC connection string in Server without requesting a token', async () => {
		const warmupSpy = stubWarmup();
		const poolSpy = stubPool(workingPool().pool);
		const { context } = testFunctions();

		const result = await fabricSqlConnectionTest.call(
			context,
			credential({ server: 'DRIVER={ODBC Driver 18 for SQL Server};SERVER=abc' }),
		);

		expect(result.status).toBe('Error');
		expect(result.message).toContain('only the host name');
		expect(warmupSpy).not.toHaveBeenCalled();
		poolSpy.mockRestore();
		warmupSpy.mockRestore();
	});

	it('rejects an empty server', async () => {
		const warmupSpy = stubWarmup();
		const { context } = testFunctions();

		const result = await fabricSqlConnectionTest.call(context, credential({ server: '  ' }));

		expect(result).toEqual({ status: 'Error', message: 'Server is empty.' });
		warmupSpy.mockRestore();
	});

	it('handles a credential with no data at all', async () => {
		const { context } = testFunctions();

		const result = await fabricSqlConnectionTest.call(context, {
			id: 'c1',
			name: 'Fabric',
			type: 'fabricSqlApi',
		} as ICredentialsDecrypted);

		expect(result.status).toBe('Error');
	});
});
