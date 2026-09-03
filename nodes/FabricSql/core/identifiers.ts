import { InvalidIdentifierError } from './errors';

const MAX_QUALIFIED_PARTS = 3;

/**
 * Wrap a single SQL identifier in brackets, escaping any `]` it contains.
 *
 * `]` must be doubled, otherwise a name like `a]b` would close the bracket early and the
 * remainder would be parsed as SQL. Names already given in bracket form are unwrapped and
 * re-quoted so the result is normalized either way.
 */
export function quoteIdentifier(name: string): string {
	const trimmed = name.trim();

	if (trimmed === '') {
		throw new InvalidIdentifierError('Identifier is empty.');
	}

	const bare = isBracketed(trimmed) ? unbracket(trimmed) : trimmed;

	if (bare.trim() === '') {
		throw new InvalidIdentifierError('Identifier is empty.');
	}

	return `[${bare.replace(/]/g, ']]')}]`;
}

/**
 * Quote a possibly qualified name: `dbo.t` becomes `[dbo].[t]`.
 *
 * Each part is quoted separately — quoting the whole string would produce `[dbo.t]`, which
 * names a single table that happens to contain a dot. Dots inside brackets are not separators.
 */
export function quoteQualifiedName(name: string): string {
	const parts = splitQualifiedName(name);

	if (parts.length === 0) {
		throw new InvalidIdentifierError('Identifier is empty.');
	}

	if (parts.length > MAX_QUALIFIED_PARTS) {
		throw new InvalidIdentifierError(
			`Name "${name.trim()}" has ${parts.length} parts; at most ${MAX_QUALIFIED_PARTS} ` +
				'([database].[schema].[object]) are supported.',
		);
	}

	return parts.map(quoteIdentifier).join('.');
}

/**
 * Split a qualified name on unbracketed dots.
 *
 * Exported because the schema operations need the parts themselves — `INFORMATION_SCHEMA`
 * lookups bind the schema and table as values, not as identifiers.
 */
export function splitQualifiedName(name: string): string[] {
	const trimmed = name.trim();

	if (trimmed === '') {
		return [];
	}

	const parts: string[] = [];
	let current = '';
	let inBracket = false;

	for (const char of trimmed) {
		if (char === '[') {
			inBracket = true;
			current += char;
		} else if (char === ']') {
			inBracket = false;
			current += char;
		} else if (char === '.' && !inBracket) {
			parts.push(current);
			current = '';
		} else {
			current += char;
		}
	}

	parts.push(current);

	return parts;
}

/** Strip the outer brackets of a bracketed identifier and undouble its escaped `]`. */
export function unbracket(name: string): string {
	const trimmed = name.trim();

	if (!isBracketed(trimmed)) {
		return trimmed;
	}

	return trimmed.slice(1, -1).replace(/]]/g, ']');
}

function isBracketed(value: string): boolean {
	return value.length >= 2 && value.startsWith('[') && value.endsWith(']');
}
