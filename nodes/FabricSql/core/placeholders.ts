import type { BuiltQuery } from '../types';
import { PlaceholderCountError } from './errors';
import { codeIndexesOf } from './scanner';

const PARAMETER_PREFIX = 'param';

/** Positions of the `?` placeholders that are actual placeholders, not literal text. */
export function placeholderPositions(sql: string): number[] {
	return codeIndexesOf(sql, '?');
}

export function countPlaceholders(sql: string): number {
	return placeholderPositions(sql).length;
}

/**
 * Replace each `?` placeholder with a named TDS parameter and return the values to bind.
 *
 * The values never enter the SQL text — they are returned in `parameters` for the transport
 * layer to hand to the driver. A `?` inside a string literal, a comment or a quoted
 * identifier is left alone.
 */
export function bindPlaceholders(sql: string, values: unknown[]): BuiltQuery {
	const positions = placeholderPositions(sql);

	if (positions.length !== values.length) {
		throw new PlaceholderCountError(positions.length, values.length);
	}

	const parameters: Record<string, unknown> = {};
	const pieces: string[] = [];
	let cursor = 0;

	positions.forEach((position, index) => {
		const name = `${PARAMETER_PREFIX}${index}`;
		pieces.push(sql.slice(cursor, position), `@${name}`);
		parameters[name] = values[index];
		cursor = position + 1;
	});

	pieces.push(sql.slice(cursor));

	return { sql: pieces.join(''), parameters };
}
