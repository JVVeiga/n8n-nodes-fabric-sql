import { describe, expect, it, vi } from 'vitest';

import {
	FABRIC_WORKSPACES_URL,
	warmUpFabricToken,
} from '../../nodes/FabricSql/transport/warmup';
import type { FabricSqlCredentials } from '../../nodes/FabricSql/types';

const credentials: FabricSqlCredentials = {
	server: 'abc.datawarehouse.fabric.microsoft.com',
	database: 'lake',
	tenantId: 'tenant-1',
	clientId: 'client-1',
	clientSecret: 'secret-1',
	connectTimeout: 30_000,
	requestTimeout: 30_000,
	allowWriteOperations: false,
};

const token = async () => 'token-abc';

describe('warmUpFabricToken', () => {
	it('issues one authenticated GET against the workspaces endpoint', async () => {
		const request = vi.fn(async () => ({ value: [] }));

		const outcome = await warmUpFabricToken(credentials, request, token);

		expect(outcome).toEqual({ ok: true });
		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith({
			method: 'GET',
			uri: FABRIC_WORKSPACES_URL,
			headers: { Authorization: 'Bearer token-abc' },
			json: true,
		});
	});

	it('reports an HTTP failure without throwing', async () => {
		const request = vi.fn(async () => {
			throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
		});

		await expect(warmUpFabricToken(credentials, request, token)).resolves.toEqual({
			ok: false,
			detail: '403 Forbidden',
		});
	});

	it('reports an HTTP failure with no status code', async () => {
		const request = vi.fn(async () => {
			throw new Error('socket closed');
		});

		await expect(warmUpFabricToken(credentials, request, token)).resolves.toEqual({
			ok: false,
			detail: 'socket closed',
		});
	});

	it('reports a token failure and never reaches the API', async () => {
		const request = vi.fn(async () => ({}));
		const failingToken = async () => {
			throw new Error('AADSTS7000215');
		};

		const outcome = await warmUpFabricToken(credentials, request, failingToken);

		expect(outcome).toEqual({
			ok: false,
			detail: 'could not acquire a Fabric API token (AADSTS7000215)',
		});
		expect(request).not.toHaveBeenCalled();
	});

	it('handles a thrown string', async () => {
		const request = vi.fn(async () => {
			throw 'plain failure';
		});

		await expect(warmUpFabricToken(credentials, request, token)).resolves.toEqual({
			ok: false,
			detail: 'plain failure',
		});
	});

	it('handles a thrown value with nothing usable', async () => {
		const request = vi.fn(async () => {
			throw {};
		});

		await expect(warmUpFabricToken(credentials, request, token)).resolves.toEqual({
			ok: false,
			detail: 'unknown error',
		});
	});

	it('never throws, whatever the request does', async () => {
		const request = vi.fn(async () => {
			throw null;
		});

		await expect(warmUpFabricToken(credentials, request, token)).resolves.toMatchObject({
			ok: false,
		});
	});
});
