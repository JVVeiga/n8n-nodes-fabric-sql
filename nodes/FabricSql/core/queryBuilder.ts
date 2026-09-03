import type { BuiltQuery, SelectOptions, WhereCondition, WhereOperator } from '../types';
import { FabricSqlError } from './errors';
import { quoteIdentifier, quoteQualifiedName, splitQualifiedName, unbracket } from './identifiers';

/**
 * SQL Server accepts at most 2100 parameters in one batch, so multi-row statements are split
 * into chunks that stay under it.
 */
export const MSSQL_PARAMETER_LIMIT = 2100;

/**
 * Operator text is looked up, never taken from input.
 *
 * The operator arrives as one of a closed set of keys, so the comparison itself cannot be
 * turned into arbitrary SQL even though it is spliced into the statement.
 */
const OPERATOR_SQL: Record<WhereOperator, string> = {
	equal: '=',
	notEqual: '<>',
	greaterThan: '>',
	greaterThanOrEqual: '>=',
	lessThan: '<',
	lessThanOrEqual: '<=',
	like: 'LIKE',
	isNull: 'IS NULL',
	isNotNull: 'IS NOT NULL',
};

const VALUELESS_OPERATORS: ReadonlySet<WhereOperator> = new Set(['isNull', 'isNotNull']);

/** `SELECT [cols] FROM [table] WHERE ...`, with every value bound and every name quoted. */
export function buildSelect(options: SelectOptions): BuiltQuery {
	const parameters: Record<string, unknown> = {};
	const columns =
		options.columns && options.columns.length > 0
			? options.columns.map(quoteIdentifier).join(', ')
			: '*';

	const top = options.limit !== undefined && options.limit > 0 ? 'TOP (@limit) ' : '';

	if (top !== '') {
		parameters.limit = options.limit;
	}

	const where = buildWhereClause(options.where ?? [], parameters);

	return {
		sql: `SELECT ${top}${columns} FROM ${quoteQualifiedName(options.table)}${where}`,
		parameters,
	};
}

/** One `INSERT` per parameter chunk, so a large batch never blows the 2100-parameter ceiling. */
export function buildInsert(
	table: string,
	columns: string[],
	rows: Array<Record<string, unknown>>,
): BuiltQuery[] {
	if (columns.length === 0) {
		throw new FabricSqlError('Insert requires at least one column.');
	}

	const target = quoteQualifiedName(table);
	const columnList = columns.map(quoteIdentifier).join(', ');

	return chunkByParameterLimit(rows, columns.length).map((chunk) => {
		const parameters: Record<string, unknown> = {};
		const tuples = chunk.map((row, rowIndex) => {
			const placeholders = columns.map((column, columnIndex) => {
				const name = `r${rowIndex}c${columnIndex}`;
				parameters[name] = row[column] ?? null;
				return `@${name}`;
			});

			return `(${placeholders.join(', ')})`;
		});

		return {
			sql: `INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(', ')}`,
			parameters,
		};
	});
}

/** `UPDATE ... SET ... WHERE [match] = @match`, values bound on both sides. */
export function buildUpdate(
	table: string,
	columns: string[],
	row: Record<string, unknown>,
	matchColumn: string,
): BuiltQuery {
	const updatable = columns.filter((column) => column !== matchColumn);

	if (updatable.length === 0) {
		throw new FabricSqlError(
			`Update requires at least one column other than the match column "${matchColumn}".`,
		);
	}

	const parameters: Record<string, unknown> = { match: row[matchColumn] ?? null };
	const assignments = updatable.map((column, index) => {
		const name = `s${index}`;
		parameters[name] = row[column] ?? null;
		return `${quoteIdentifier(column)} = @${name}`;
	});

	return {
		sql:
			`UPDATE ${quoteQualifiedName(table)} SET ${assignments.join(', ')} ` +
			`WHERE ${quoteIdentifier(matchColumn)} = @match`,
		parameters,
	};
}

/** One `DELETE ... WHERE [match] IN (...)` per parameter chunk. */
export function buildDelete(
	table: string,
	matchColumn: string,
	values: unknown[],
): BuiltQuery[] {
	if (values.length === 0) {
		return [];
	}

	const target = quoteQualifiedName(table);
	const column = quoteIdentifier(matchColumn);

	return chunkByParameterLimit(values, 1).map((chunk) => {
		const parameters: Record<string, unknown> = {};
		const placeholders = chunk.map((value, index) => {
			const name = `m${index}`;
			parameters[name] = value;
			return `@${name}`;
		});

		return {
			sql: `DELETE FROM ${target} WHERE ${column} IN (${placeholders.join(', ')})`,
			parameters,
		};
	});
}

/**
 * Split `rows` so that `rows-per-chunk * paramsPerRow` never exceeds `limit`.
 *
 * A single row needing more parameters than the limit cannot be sent at all, so that is an
 * error rather than a silently oversized statement.
 */
export function chunkByParameterLimit<T>(
	rows: T[],
	paramsPerRow: number,
	limit: number = MSSQL_PARAMETER_LIMIT,
): T[][] {
	if (rows.length === 0) {
		return [];
	}

	if (paramsPerRow <= 0) {
		return [rows];
	}

	const perChunk = Math.floor(limit / paramsPerRow);

	if (perChunk < 1) {
		throw new FabricSqlError(
			`A single row needs ${paramsPerRow} parameters, over the ${limit}-parameter limit for one ` +
				'statement. Reduce the number of columns.',
		);
	}

	const chunks: T[][] = [];

	for (let index = 0; index < rows.length; index += perChunk) {
		chunks.push(rows.slice(index, index + perChunk));
	}

	return chunks;
}

/** Every table and view visible to the principal. */
export function listTablesQuery(): BuiltQuery {
	return {
		sql:
			'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ' +
			'ORDER BY TABLE_SCHEMA, TABLE_NAME',
		parameters: {},
	};
}

/**
 * Column metadata for one table.
 *
 * The table name is a *value* here, not an identifier — `INFORMATION_SCHEMA` is queried by
 * string — so it is bound rather than quoted. A qualified name is split so the schema binds
 * separately; an unqualified name matches in any schema.
 */
export function describeTableQuery(table: string): BuiltQuery {
	const parts = splitQualifiedName(table).map(unbracket);

	if (parts.length === 0 || parts.some((part) => part.trim() === '')) {
		throw new FabricSqlError('Table name is empty.');
	}

	const tableName = parts[parts.length - 1];
	const schemaName = parts.length > 1 ? parts[parts.length - 2] : undefined;

	const parameters: Record<string, unknown> = { table: tableName };
	let filter = 'WHERE TABLE_NAME = @table';

	if (schemaName !== undefined) {
		parameters.schema = schemaName;
		filter += ' AND TABLE_SCHEMA = @schema';
	}

	return {
		sql:
			'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, ' +
			'CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT ' +
			`FROM INFORMATION_SCHEMA.COLUMNS ${filter} ORDER BY ORDINAL_POSITION`,
		parameters,
	};
}

function buildWhereClause(
	conditions: WhereCondition[],
	parameters: Record<string, unknown>,
): string {
	if (conditions.length === 0) {
		return '';
	}

	const clauses = conditions.map((condition, index) => {
		const operator = OPERATOR_SQL[condition.operator];

		if (operator === undefined) {
			throw new FabricSqlError(`Unsupported comparison operator "${condition.operator}".`);
		}

		const column = quoteIdentifier(condition.column);

		if (VALUELESS_OPERATORS.has(condition.operator)) {
			return `${column} ${operator}`;
		}

		const name = `w${index}`;
		parameters[name] = condition.value ?? null;

		return `${column} ${operator} @${name}`;
	});

	return ` WHERE ${clauses.join(' AND ')}`;
}
