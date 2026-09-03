import type { OperationHandler } from '../types';
import { describeTable } from './describeTable';
import { executeQuery } from './executeQuery';
import { listTables } from './listTables';
import { selectRows } from './selectRows';

/**
 * Every operation, keyed `resource:operation`.
 *
 * A registry rather than a switch inside `execute`, so each operation is a small file that
 * can be read and tested on its own and the node itself stays wiring.
 */
export const operations: Record<string, OperationHandler> = {
	'query:executeQuery': executeQuery,
	'row:select': selectRows,
	'schema:listTables': listTables,
	'schema:describeTable': describeTable,
};

export function resolveOperation(
	resource: string,
	operation: string,
): OperationHandler | undefined {
	return operations[`${resource}:${operation}`];
}
