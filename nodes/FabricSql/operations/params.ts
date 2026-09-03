import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';

import { FabricSqlError } from '../core/errors';
import type { WhereCondition, WhereOperator } from '../types';

type ParameterReader = Pick<IExecuteFunctions | ILoadOptionsFunctions, 'getNodeParameter'>;

/**
 * Read a table name from a resourceLocator field.
 *
 * Handles both shapes the field can produce — the locator object, and a plain string when the
 * value came from an expression — so callers never have to care which mode the user picked.
 */
export function getTableName(ctx: ParameterReader, itemIndex: number, name = 'table'): string {
	const raw = ctx.getNodeParameter(name, itemIndex, '') as unknown;
	const value = typeof raw === 'string' ? raw : String((raw as IDataObject)?.value ?? '');

	if (value.trim() === '') {
		throw new FabricSqlError('Table is empty. Pick a table from the list, or type its name.');
	}

	return value.trim();
}

/** Split a comma-separated column field, dropping blanks. */
export function getColumns(ctx: ParameterReader, itemIndex: number, name = 'columns'): string[] {
	const raw = ctx.getNodeParameter(name, itemIndex, '') as unknown;

	if (Array.isArray(raw)) {
		return raw.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
	}

	return String(raw ?? '')
		.split(',')
		.map((column) => column.trim())
		.filter((column) => column !== '');
}

/**
 * Values for the `?` placeholders, in the order the user listed them.
 *
 * An entry's value keeps whatever type the expression resolved to, so `{{ 42 }}` binds a
 * number while a plain entry binds text.
 */
export function getQueryParameters(ctx: ParameterReader, itemIndex: number): unknown[] {
	const collection = ctx.getNodeParameter('queryParameters', itemIndex, {}) as IDataObject;
	const entries = collection?.parameter;

	if (!Array.isArray(entries)) {
		return [];
	}

	return entries.map((entry) => (entry as IDataObject)?.value);
}

/** Where conditions from the Filters collection. */
export function getFilters(ctx: ParameterReader, itemIndex: number): WhereCondition[] {
	const collection = ctx.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const entries = collection?.condition;

	if (!Array.isArray(entries)) {
		return [];
	}

	return entries.map((raw) => {
		const entry = raw as IDataObject;
		const column = String(entry?.column ?? '').trim();

		if (column === '') {
			throw new FabricSqlError('A filter condition is missing its column name.');
		}

		return {
			column,
			operator: (entry?.operator ?? 'equal') as WhereOperator,
			value: entry?.value,
		};
	});
}
