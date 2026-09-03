/**
 * A single-pass T-SQL scanner that classifies every character as code, string, identifier
 * or comment.
 *
 * Both the placeholder binder and the read-only guard need to know whether a character is
 * "really" SQL or just text inside a literal or comment. Sharing one scanner means they can
 * never disagree: a `?` the binder ignores is the same `?` the guard ignores.
 */

export type SqlContext = 'code' | 'string' | 'identifier' | 'comment';

type Mode = 'code' | 'string' | 'bracket' | 'quoted' | 'line-comment' | 'block-comment';

export type CharVisitor = (char: string, index: number, context: SqlContext) => void;

/**
 * Walk `sql`, calling `onChar` once per character with the context it appears in.
 *
 * Handles: `'...'` with `''` escapes, `[...]` with `]]` escapes, `"..."` with `""` escapes,
 * `-- line comments`, and `/* block comments *\/` including T-SQL's nesting.
 */
export function scanSql(sql: string, onChar: CharVisitor): void {
	let mode: Mode = 'code';
	let blockDepth = 0;
	let i = 0;

	const emit = (index: number, context: SqlContext) => onChar(sql[index], index, context);
	const emitPair = (index: number, context: SqlContext) => {
		emit(index, context);
		emit(index + 1, context);
	};

	while (i < sql.length) {
		const char = sql[i];
		const next = i + 1 < sql.length ? sql[i + 1] : '';

		if (mode === 'code') {
			if (char === '-' && next === '-') {
				mode = 'line-comment';
				emitPair(i, 'comment');
				i += 2;
			} else if (char === '/' && next === '*') {
				mode = 'block-comment';
				blockDepth = 1;
				emitPair(i, 'comment');
				i += 2;
			} else if (char === "'") {
				mode = 'string';
				emit(i, 'string');
				i += 1;
			} else if (char === '[') {
				mode = 'bracket';
				emit(i, 'identifier');
				i += 1;
			} else if (char === '"') {
				mode = 'quoted';
				emit(i, 'identifier');
				i += 1;
			} else {
				emit(i, 'code');
				i += 1;
			}
			continue;
		}

		if (mode === 'string') {
			if (char === "'" && next === "'") {
				emitPair(i, 'string');
				i += 2;
			} else if (char === "'") {
				mode = 'code';
				emit(i, 'string');
				i += 1;
			} else {
				emit(i, 'string');
				i += 1;
			}
			continue;
		}

		if (mode === 'bracket' || mode === 'quoted') {
			const closer = mode === 'bracket' ? ']' : '"';

			if (char === closer && next === closer) {
				emitPair(i, 'identifier');
				i += 2;
			} else if (char === closer) {
				mode = 'code';
				emit(i, 'identifier');
				i += 1;
			} else {
				emit(i, 'identifier');
				i += 1;
			}
			continue;
		}

		if (mode === 'line-comment') {
			emit(i, 'comment');
			if (char === '\n') {
				mode = 'code';
			}
			i += 1;
			continue;
		}

		// block-comment
		if (char === '/' && next === '*') {
			blockDepth += 1;
			emitPair(i, 'comment');
			i += 2;
		} else if (char === '*' && next === '/') {
			blockDepth -= 1;
			emitPair(i, 'comment');
			i += 2;
			if (blockDepth === 0) {
				mode = 'code';
			}
		} else {
			emit(i, 'comment');
			i += 1;
		}
	}
}

/** Indexes of every character that the scanner classified as `code`. */
export function codeIndexesOf(sql: string, char: string): number[] {
	const found: number[] = [];

	scanSql(sql, (current, index, context) => {
		if (context === 'code' && current === char) {
			found.push(index);
		}
	});

	return found;
}

/**
 * `sql` with every string literal, quoted identifier and comment blanked out to spaces.
 *
 * Indexes line up with the original, so a keyword found here is at the same offset in `sql`.
 * Line breaks survive blanking as themselves, so line numbers line up too.
 */
export function codeOnly(sql: string): string {
	const chars: string[] = [];

	scanSql(sql, (char, _index, context) => {
		if (context === 'code' || char === '\n' || char === '\r') {
			chars.push(char);
		} else {
			chars.push(' ');
		}
	});

	return chars.join('');
}
