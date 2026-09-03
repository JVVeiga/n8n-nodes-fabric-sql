import type { Operation } from '../types';
import { deleteRows } from './deleteRows';
import { describeTable } from './describeTable';
import { executeQuery } from './executeQuery';
import { insertRows } from './insertRows';
import { listTables } from './listTables';
import { selectRows } from './selectRows';
import { updateRows } from './updateRows';

/**
 * Every operation, keyed `resource:operation`.
 *
 * A registry rather than a switch inside `execute`, so each operation is a small file that
 * can be read and tested on its own and the node itself stays wiring.
 *
 * `kind` says how the operation wants to be fed. Insert and delete aggregate across items, so
 * they take the whole list at once; everything else runs per item.
 */
export const operations: Record<string, Operation> = {
	'query:executeQuery': { kind: 'item', run: executeQuery },
	'row:select': { kind: 'item', run: selectRows },
	'row:insert': { kind: 'batch', run: insertRows },
	'row:update': { kind: 'item', run: updateRows },
	'row:delete': { kind: 'batch', run: deleteRows },
	'schema:listTables': { kind: 'item', run: listTables },
	'schema:describeTable': { kind: 'item', run: describeTable },
};

export function resolveOperation(resource: string, operation: string): Operation | undefined {
	return operations[`${resource}:${operation}`];
}
