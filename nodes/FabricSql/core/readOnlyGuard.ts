import { EmptySqlError, ReadOnlySqlError } from './errors';
import { codeOnly, scanSql } from './scanner';

/**
 * Statement keywords that may start a query against a read-only endpoint.
 *
 * `DECLARE` and `SET` are here because a legitimate read often begins by declaring a local
 * variable; neither can modify stored data.
 */
const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH', 'DECLARE', 'SET']);

/**
 * Keywords that write, change structure, change permissions or run arbitrary code.
 *
 * Checked anywhere in a statement's code, not just at the start, because a CTE can lead with
 * `WITH` and still end in `DELETE FROM cte`.
 */
const FORBIDDEN_KEYWORDS = [
	'INSERT',
	'UPDATE',
	'DELETE',
	'MERGE',
	'DROP',
	'ALTER',
	'CREATE',
	'TRUNCATE',
	'EXEC',
	'EXECUTE',
	'GRANT',
	'REVOKE',
	'DENY',
	'BACKUP',
	'RESTORE',
] as const;

/**
 * Split a batch into individual statements on unquoted semicolons.
 *
 * A `;` inside a string literal or comment is not a separator, which is why this reuses the
 * shared scanner rather than `String.prototype.split`.
 */
export function splitStatements(sql: string): string[] {
	const boundaries: number[] = [];

	scanSql(sql, (char, index, context) => {
		if (context === 'code' && char === ';') {
			boundaries.push(index);
		}
	});

	const statements: string[] = [];
	let start = 0;

	for (const boundary of boundaries) {
		statements.push(sql.slice(start, boundary));
		start = boundary + 1;
	}

	statements.push(sql.slice(start));

	return statements.filter((statement) => hasCode(statement));
}

/**
 * Reject anything that is not a read before it reaches the server.
 *
 * This is a usability guard, not a security boundary. A Fabric SQL analytics endpoint
 * enforces read-only access itself; the point here is to fail with a message that explains
 * *why* instead of surfacing a bare driver rejection. Callers skip this entirely when the
 * credential opts into writes, so it must never be relied on for authorization.
 */
export function assertReadOnly(sql: string): void {
	if (sql.trim() === '') {
		throw new EmptySqlError();
	}

	const statements = splitStatements(sql);

	if (statements.length === 0) {
		// Non-empty input that is entirely comments has nothing to run.
		throw new EmptySqlError();
	}

	for (const statement of statements) {
		const masked = codeOnly(statement);
		const leading = leadingKeyword(masked);

		if (leading !== undefined && !ALLOWED_LEADING_KEYWORDS.has(leading)) {
			throw new ReadOnlySqlError(leading);
		}

		const forbidden = findForbiddenKeyword(masked);

		if (forbidden !== undefined) {
			throw new ReadOnlySqlError(forbidden);
		}
	}
}

/** True when a statement contains something other than whitespace, comments and literals. */
function hasCode(statement: string): boolean {
	return codeOnly(statement).trim() !== '';
}

/**
 * First bare word of a statement, upper-cased.
 *
 * Leading parentheses are skipped so `(SELECT 1) UNION (SELECT 2)` reads as `SELECT`.
 */
function leadingKeyword(masked: string): string | undefined {
	const match = /^[\s(]*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked);

	return match ? match[1].toUpperCase() : undefined;
}

function findForbiddenKeyword(masked: string): string | undefined {
	return FORBIDDEN_KEYWORDS.find((keyword) =>
		new RegExp(`\\b${keyword}\\b`, 'i').test(masked),
	);
}
