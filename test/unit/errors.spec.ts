import { describe, expect, it } from 'vitest';

import { ReadOnlySqlError } from '../../nodes/FabricSql/core/errors';
import {
	describeConnectionError,
	redact,
	toNodeError,
} from '../../nodes/FabricSql/transport/errors';

const context = {
	server: 'abc123.datawarehouse.fabric.microsoft.com',
	database: 'my_lakehouse',
	tenantId: 'tenant-1',
	clientId: 'client-1',
	clientSecret: 'super-secret-value',
};

const node = {
	id: 'n1',
	name: 'Fabric SQL',
	type: 'n8n-nodes-fabric-sql.fabricSql',
	typeVersion: 1,
	position: [0, 0] as [number, number],
	parameters: {},
};

function driverError(message: string, code?: string): Error & { code?: string } {
	const error: Error & { code?: string } = new Error(message);

	if (code !== undefined) {
		error.code = code;
	}

	return error;
}

describe('describeConnectionError — Entra ID', () => {
	it('names an invalid client secret', () => {
		const described = describeConnectionError(
			driverError('AADSTS7000215: Invalid client secret provided.'),
			context,
		);

		expect(described.message).toContain('Client secret was rejected by Entra ID (AADSTS7000215)');
		expect(described.message).toContain('secret value, not the secret ID');
	});

	it('names an expired client secret', () => {
		expect(
			describeConnectionError(driverError('AADSTS7000222: expired keys'), context).message,
		).toContain('client secret has expired');
	});

	it('names an application missing from the tenant, with both ids', () => {
		const described = describeConnectionError(
			driverError('AADSTS700016: Application with identifier was not found'),
			context,
		);

		expect(described.message).toContain('client-1');
		expect(described.message).toContain('tenant-1');
		expect(described.message).toContain('AADSTS700016');
	});

	it('names a missing tenant', () => {
		expect(
			describeConnectionError(driverError('AADSTS90002: Tenant not found'), context).message,
		).toContain('was not found (AADSTS90002)');
	});

	it('falls back to placeholders when ids are unknown', () => {
		expect(describeConnectionError(driverError('AADSTS700016'), {}).message).toContain(
			'(client ID)',
		);
	});
});

describe('describeConnectionError — authorization', () => {
	it('explains a token-identified principal rejection', () => {
		const described = describeConnectionError(
			driverError("Login failed for user '<token-identified principal>'."),
			context,
		);

		expect(described.message).toContain('authenticated but has no access to my_lakehouse');
		expect(described.message).toContain('Fabric workspace');
		expect(described.message).toContain('Service principals can use Fabric APIs');
	});

	it('matches a plain login failure too', () => {
		expect(
			describeConnectionError(driverError('Login failed for user "svc".'), context).message,
		).toContain('has no access to');
	});
});

describe('describeConnectionError — host never reached', () => {
	it.each(['ETIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH'])(
		'explains %s as a port or host problem',
		(code) => {
			const described = describeConnectionError(driverError('Failed', code), context);

			expect(described.message).toContain(
				'Could not reach abc123.datawarehouse.fabric.microsoft.com:1433',
			);
			expect(described.message).toContain('TCP 1433');
		},
	);

	it('matches a DNS failure by message when there is no code', () => {
		expect(
			describeConnectionError(driverError('getaddrinfo ENOTFOUND abc'), context).message,
		).toContain('Could not reach');
	});
});

describe('describeConnectionError — connection cut mid-handshake', () => {
	// A socket that opens and is then closed looks identical whether a firewall cut it or the
	// driver is too old for Fabric. Blaming the firewall alone sends people to the wrong team.
	it.each(['ESOCKET', 'ECONNRESET'])('names both causes for %s', (code) => {
		const described = describeConnectionError(driverError('Failed', code), context);

		expect(described.message).toContain('established and then');
		expect(described.message).toContain('firewall or proxy');
		expect(described.message).toContain('tedious 19.2.1');
	});

	it('reports the tedious version actually resolved, so it can be compared', () => {
		const described = describeConnectionError(driverError('Failed', 'ESOCKET'), context);

		expect(described.message).toMatch(/resolved tedious \d+\.\d+\.\d+/);
	});

	it('matches a socket hang up by message when there is no code', () => {
		const described = describeConnectionError(
			driverError('Connection lost - socket hang up'),
			context,
		);

		expect(described.message).toContain('established and then');
		expect(described.message).not.toContain('Could not reach');
	});

	it('does not claim the host was unreachable, which it was not', () => {
		expect(describeConnectionError(driverError('Failed', 'ESOCKET'), context).message).not.toMatch(
			/^Could not reach/,
		);
	});
});

describe('describeConnectionError — read-only rejection', () => {
	it('explains a server-side read-only rejection', () => {
		const described = describeConnectionError(
			driverError('The target is read-only and cannot be modified.'),
			context,
		);

		expect(described.message).toContain('read-only');
		expect(described.message).toContain('Fabric Warehouse');
	});

	it('passes our own read-only guard message through unchanged', () => {
		const guardError = new ReadOnlySqlError('DELETE');

		expect(describeConnectionError(guardError, context).message).toBe(guardError.message);
	});
});

describe('describeConnectionError — fallthrough and context', () => {
	it('preserves an unrecognized message', () => {
		expect(describeConnectionError(driverError('Something odd happened'), context).message).toBe(
			'Something odd happened',
		);
	});

	it('does not repeat the driver text when it is already the message', () => {
		expect(
			describeConnectionError(driverError('Something odd happened'), context).description,
		).toBeUndefined();
	});

	it('keeps the driver text as the description when the message was mapped', () => {
		const described = describeConnectionError(
			driverError('AADSTS7000215: Invalid client secret provided.'),
			context,
		);

		expect(described.description).toContain('AADSTS7000215: Invalid client secret provided.');
	});

	it('reports a failed warm-up only alongside a connection failure', () => {
		const described = describeConnectionError(driverError('Failed', 'ESOCKET'), {
			...context,
			warmup: { ok: false, detail: '403 Forbidden' },
		});

		expect(described.description).toContain('Fabric REST warm-up also failed: 403 Forbidden');
	});

	it('says nothing about a successful warm-up', () => {
		const described = describeConnectionError(driverError('Failed', 'ESOCKET'), {
			...context,
			warmup: { ok: true },
		});

		expect(described.description ?? '').not.toContain('warm-up');
	});

	it('handles a string error', () => {
		expect(describeConnectionError('plain string failure').message).toBe('plain string failure');
	});

	it('handles an object with a message field', () => {
		expect(describeConnectionError({ message: 'from object' }).message).toBe('from object');
	});

	it('handles a value with nothing usable', () => {
		expect(describeConnectionError(undefined).message).toBe('Unknown error');
	});
});

describe('redact', () => {
	it('masks the secret', () => {
		expect(redact('pwd=super-secret-value;', 'super-secret-value')).toBe('pwd=***;');
	});

	it('masks every occurrence', () => {
		expect(redact('a-secret-x and a-secret-x', 'a-secret-x')).toBe('*** and ***');
	});

	it('leaves the text alone when there is no secret', () => {
		expect(redact('nothing to hide', undefined)).toBe('nothing to hide');
	});

	it('ignores a suspiciously short secret rather than mangling the text', () => {
		expect(redact('a and b', 'a')).toBe('a and b');
	});
});

describe('toNodeError', () => {
	it('produces a node error carrying the mapped message', () => {
		const error = toNodeError(node, driverError('AADSTS7000215'), context, 2);

		expect(error.message).toContain('Client secret was rejected by Entra ID');
		expect(error.context.itemIndex).toBe(2);
	});

	it('never leaks the client secret into an unmapped message', () => {
		const error = toNodeError(
			node,
			driverError(`Login refused. PWD=${context.clientSecret};`),
			context,
		);

		expect(error.message).not.toContain(context.clientSecret);
		expect(error.message).toContain('***');
	});

	it('never leaks the client secret into the description of a mapped error', () => {
		const error = toNodeError(
			node,
			driverError(`AADSTS7000215: bad secret PWD=${context.clientSecret};`),
			context,
		);

		expect(error.message).not.toContain(context.clientSecret);
		expect(error.description ?? '').not.toContain(context.clientSecret);
		expect(error.description ?? '').toContain('***');
	});
});
