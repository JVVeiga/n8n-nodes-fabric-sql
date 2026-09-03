import { createRequire } from 'node:module';

import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { FabricSqlError } from '../core/errors';
import type { WarmupOutcome } from '../types';

export interface ErrorContext {
	server?: string;
	database?: string;
	tenantId?: string;
	clientId?: string;
	/** Used only to strip the secret out of anything we surface. */
	clientSecret?: string;
	warmup?: WarmupOutcome;
}

export interface DescribedError {
	message: string;
	description?: string;
}

const SECRET_MASK = '***';

/**
 * Turn a driver or Entra ID failure into a message that names the fix.
 *
 * The failure modes below are the ones that actually happen when wiring a service principal
 * to Fabric, and each is indistinguishable from the others in the raw driver output — a wrong
 * secret, a missing tenant grant and a blocked port can all surface as a timeout. The
 * original message is always kept as the description so nothing is hidden.
 */
export function describeConnectionError(
	error: unknown,
	context: ErrorContext = {},
): DescribedError {
	const raw = messageOf(error);

	// Our own errors are already written for the user; classifying them again would rewrite,
	// for instance, ReadOnlySqlError's message just because it contains "read-only".
	if (error instanceof FabricSqlError) {
		return finalize({ message: raw }, raw, context);
	}

	const code = codeOf(error);
	const described = classify(raw, code, context) ?? { message: raw };

	return finalize(described, raw, context);
}

/** Wrap any failure as a node error, with the mapped message and the original as description. */
export function toNodeError(
	node: INode,
	error: unknown,
	context: ErrorContext = {},
	itemIndex?: number,
): NodeOperationError {
	const { message, description } = describeConnectionError(error, context);

	return new NodeOperationError(node, redact(message, context.clientSecret), {
		description: description === undefined ? undefined : redact(description, context.clientSecret),
		itemIndex,
	});
}

/**
 * Replace the client secret wherever it appears.
 *
 * Driver and Entra errors sometimes echo the connection configuration back, and node errors
 * are persisted in execution data where anyone with workflow access can read them.
 */
export function redact(value: string, secret?: string): string {
	if (!secret || secret.length < 4) {
		return value;
	}

	return value.split(secret).join(SECRET_MASK);
}

function classify(
	raw: string,
	code: string | undefined,
	context: ErrorContext,
): DescribedError | undefined {
	if (raw.includes('AADSTS7000215')) {
		return {
			message:
				'Client secret was rejected by Entra ID (AADSTS7000215). Generate a new secret for the ' +
				'app registration and paste the secret value, not the secret ID.',
		};
	}

	if (raw.includes('AADSTS7000222')) {
		return {
			message:
				'The client secret has expired (AADSTS7000222). Create a new secret for the app ' +
				'registration.',
		};
	}

	if (raw.includes('AADSTS700016')) {
		return {
			message:
				`Application ${context.clientId ?? '(client ID)'} was not found in tenant ` +
				`${context.tenantId ?? '(tenant ID)'} (AADSTS700016). Check the Client ID and Tenant ID.`,
		};
	}

	if (raw.includes('AADSTS90002')) {
		return {
			message:
				`Tenant ${context.tenantId ?? '(tenant ID)'} was not found (AADSTS90002). Check the ` +
				'Tenant ID.',
		};
	}

	if (raw.includes('<token-identified principal>') || /login failed for user/i.test(raw)) {
		return {
			message:
				'The service principal authenticated but has no access to ' +
				`${context.database ?? 'the database'}. Add it to the Fabric workspace (or to the ` +
				"lakehouse item), and make sure 'Service principals can use Fabric APIs' is enabled in " +
				'the tenant admin settings.',
		};
	}

	if (isUnreachable(code, raw)) {
		return {
			message:
				`Could not reach ${context.server ?? 'the server'}:1433. Confirm outbound TCP 1433 is ` +
				'open from this n8n instance, and that the host came from Lakehouse → Settings → SQL ' +
				'connection string.',
		};
	}

	// Deliberately NOT folded into the message above. A connection that opens and is then cut
	// has two very different causes that look identical here: egress being dropped, and the
	// Fabric LOGIN7 handshake that tedious only fixed in 19.2.1. Saying "open port 1433" when
	// the real cause is the driver sends people to the wrong team for an afternoon, which is
	// the exact failure this node exists to prevent — so both are named, with the version.
	if (isConnectionCut(code, raw)) {
		return {
			message:
				`The connection to ${context.server ?? 'the server'}:1433 was established and then ` +
				'dropped. Two causes look the same here. Either outbound TCP 1433 is being cut by a ' +
				'firewall or proxy, or the TDS driver is too old for Fabric — the handshake fix landed ' +
				`in tedious 19.2.1, and this install resolved ${tediousVersion()}. Check the driver ` +
				'version first: it is the faster of the two to rule out.',
		};
	}

	if (/read[- ]only/i.test(raw)) {
		return {
			message:
				'The endpoint rejected the statement because it is read-only. Lakehouse SQL analytics ' +
				'endpoints accept SELECT only; writes require a Fabric Warehouse and "Allow Write ' +
				'Operations" enabled on the credential.',
		};
	}

	return undefined;
}

/** The host was never reached: no DNS, refused, no route, or nothing answered at all. */
function isUnreachable(code: string | undefined, raw: string): boolean {
	const codes = ['ETIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH'];

	if (code !== undefined && codes.includes(code)) {
		return true;
	}

	return /getaddrinfo|failed to connect|connection timeout/i.test(raw);
}

/** A socket that opened and was then closed mid-handshake — driver or network, unknowable here. */
function isConnectionCut(code: string | undefined, raw: string): boolean {
	if (code !== undefined && ['ESOCKET', 'ECONNRESET'].includes(code)) {
		return true;
	}

	return /socket hang up|connection lost|read ECONNRESET/i.test(raw);
}

/**
 * The `tedious` version actually resolved at runtime.
 *
 * Read defensively: this runs inside error handling, where throwing would replace a useful
 * message with a useless one. `mssql` declares the dependency, so it is normally present.
 */
function tediousVersion(): string {
	try {
		// createRequire, not a static import: the lookup has to be optional and happen at error
		// time. A static `import` of a transitive dependency would fail module load if it were
		// ever absent, replacing every error message with a crash.
		const pkg = createRequire(__filename)('tedious/package.json') as { version?: string };

		return pkg.version ? `tedious ${pkg.version}` : 'an unknown tedious version';
	} catch {
		return 'an unknown tedious version';
	}
}

/**
 * Attach the original text, and the warm-up outcome when it might be the real cause.
 *
 * A failed warm-up on its own is not reported — it is only meaningful once the connection has
 * also failed, since the requirement it covers is undocumented.
 */
function finalize(described: DescribedError, raw: string, context: ErrorContext): DescribedError {
	const notes: string[] = [];

	if (described.message !== raw && raw.trim() !== '') {
		notes.push(`Driver reported: ${raw}`);
	}

	if (context.warmup && !context.warmup.ok) {
		notes.push(`Fabric REST warm-up also failed: ${context.warmup.detail}`);
	}

	if (described.description !== undefined) {
		notes.unshift(described.description);
	}

	return {
		message: described.message,
		description: notes.length > 0 ? notes.join(' ') : undefined,
	};
}

function messageOf(error: unknown): string {
	if (error instanceof FabricSqlError || error instanceof Error) {
		return error.message;
	}

	if (typeof error === 'string') {
		return error;
	}

	if (error !== null && typeof error === 'object' && 'message' in error) {
		return String((error as { message: unknown }).message);
	}

	return 'Unknown error';
}

function codeOf(error: unknown): string | undefined {
	if (error !== null && typeof error === 'object' && 'code' in error) {
		const code = (error as { code: unknown }).code;

		return typeof code === 'string' ? code : undefined;
	}

	return undefined;
}
