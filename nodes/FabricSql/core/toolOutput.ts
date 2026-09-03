import type { ColumnMetadataLike, QueryResultLike } from '../types';
import { splitStatements } from './readOnlyGuard';
import { codeOnly } from './scanner';

/**
 * Shaping a result for a language model rather than for a workflow branch.
 *
 * A workflow wants one item per row, because the next node iterates. A model wants ONE
 * observation: 500 items become 500 tool results in the transcript, and the conversation runs
 * out of context before the analysis starts. Everything here exists to keep a single answer
 * small enough to reason over and honest about what it left out.
 */

export interface CompactResult {
	columns: string[];
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	/** True when rows were dropped — either past the row cap or past the character budget. */
	truncated: boolean;
	note?: string;
}

/**
 * Add `TOP (n)` when it is unambiguously safe to do so.
 *
 * The point is to stop the *server* from materializing a million rows, not just to stop us
 * reading them. But rewriting arbitrary SQL is a good way to corrupt a valid query, so this
 * only touches the one shape it can be sure about: a single statement whose first keyword is
 * `SELECT` and which has no `TOP`, `DISTINCT`, `OFFSET` or `FETCH` of its own. Anything else
 * is left exactly as written and relies on `compactResult` to cap the reading side instead.
 */
export function applyRowCap(sql: string, maxRows: number): string {
	if (maxRows <= 0) {
		return sql;
	}

	const statements = splitStatements(sql);

	if (statements.length !== 1) {
		return sql;
	}

	const masked = codeOnly(sql);

	// Only a bare leading SELECT. A CTE (`WITH`) puts the real SELECT somewhere we would have
	// to parse for, and `DISTINCT` sits between SELECT and the column list.
	if (!/^\s*SELECT\s/i.test(masked)) {
		return sql;
	}

	if (/\bTOP\s*\(|\bTOP\s+\d|\bDISTINCT\b|\bOFFSET\b|\bFETCH\b|\bINTO\b/i.test(masked)) {
		return sql;
	}

	const match = /^(\s*)(SELECT)(\s)/i.exec(sql);

	if (match === null) {
		return sql;
	}

	return `${match[1]}${match[2]} TOP (${maxRows})${match[3]}${sql.slice(match[0].length)}`;
}

/**
 * Collapse a result into one JSON-serializable answer, within both budgets.
 *
 * Rows are dropped from the end until the serialized form fits `maxChars`. A single row that
 * alone exceeds the budget is still returned — an empty answer with `truncated: true` tells
 * the model nothing, whereas one oversized row at least shows the shape of the data and lets
 * it ask a narrower question.
 */
export function compactResult(
	result: QueryResultLike,
	rows: Array<Record<string, unknown>>,
	options: { maxRows: number; maxChars: number },
): CompactResult {
	const columns = columnNamesOf(result, rows);
	const capped = options.maxRows > 0 ? rows.slice(0, options.maxRows) : rows;
	let truncated = capped.length < rows.length;
	let kept = capped;

	while (kept.length > 1 && JSON.stringify(kept).length > options.maxChars) {
		kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
		truncated = true;
	}

	const compact: CompactResult = {
		columns,
		rows: kept,
		rowCount: kept.length,
		truncated,
	};

	if (truncated) {
		compact.note =
			`Showing ${kept.length} row${kept.length === 1 ? '' : 's'}. The result was cut to stay ` +
			'within the response budget — narrow the query with a WHERE clause, an aggregate, or ' +
			'fewer columns to see the rest.';
	}

	return compact;
}

/**
 * The schema digest appended to the tool description.
 *
 * A model that does not know the table names invents them, and every invented name costs a
 * failed call and a retry. Handing it the real ones up front is the whole reason this node
 * fetches schema before the agent starts.
 */
export function formatSchemaDigest(
	columns: Array<Record<string, unknown>>,
	options: { maxChars: number; tableFilter?: string },
): string {
	const byTable = new Map<string, string[]>();

	for (const row of columns) {
		const schema = String(row.TABLE_SCHEMA ?? '');
		const table = String(row.TABLE_NAME ?? '');
		const name = String(row.COLUMN_NAME ?? '');

		// Checked before qualifying: a blank table with a schema still joins to "dbo.", which
		// is not empty and would slip through as a table named nothing.
		if (table === '' || name === '') {
			continue;
		}

		const qualified = schema === '' ? table : `${schema}.${table}`;

		const type = String(row.DATA_TYPE ?? '').toLowerCase();
		const entry = byTable.get(qualified) ?? [];
		entry.push(type === '' ? name : `${name} ${type}`);
		byTable.set(qualified, entry);
	}

	if (byTable.size === 0) {
		return '';
	}

	const lines: string[] = [];
	let used = 0;
	let omitted = 0;

	for (const [table, fields] of byTable) {
		const line = `${table}(${fields.join(', ')})`;

		if (used + line.length > options.maxChars && lines.length > 0) {
			omitted += 1;
			continue;
		}

		lines.push(line);
		used += line.length + 1;
	}

	const header = 'Available tables and columns:';

	// A list that is not the whole database MUST say so. Silently handing a model a filtered
	// subset makes it conclude the missing data does not exist — it has no way to tell a
	// deliberately narrowed list from a complete one, and it answers with full confidence
	// either way. Both causes of narrowing get named, and both point at the way out: the
	// tool's own `sql` argument can read INFORMATION_SCHEMA.
	const notes: string[] = [];

	if (options.tableFilter) {
		notes.push(`only tables matching "${options.tableFilter}" are listed`);
	}

	if (omitted > 0) {
		notes.push(`${omitted} more table${omitted === 1 ? '' : 's'} did not fit`);
	}

	const footer =
		notes.length > 0
			? `\n(This is a partial list — ${notes.join(', and ')}. Query ` +
				'INFORMATION_SCHEMA.TABLES to discover the rest.)'
			: '';

	return `${header}\n${lines.join('\n')}${footer}`;
}

function columnNamesOf(result: QueryResultLike, rows: Array<Record<string, unknown>>): string[] {
	const metadata: ColumnMetadataLike[] = result.columns?.[0] ?? [];

	if (metadata.length > 0) {
		return metadata.map((column) => column.name);
	}

	return rows.length > 0 ? Object.keys(rows[0]) : [];
}
