import { ReadOnlySqlError } from '../core/errors';
import type { FabricSqlCredentials } from '../types';

/**
 * Refuse a write unless the credential opted in.
 *
 * `displayOptions` cannot read credential values — its keys are node parameters plus
 * `@version`, `@feature` and `@tool` — so the write operations cannot be hidden from the
 * dropdown based on the credential. They are labelled Warehouse-only in the UI and enforced
 * here instead.
 */
export function assertWritesAllowed(credentials: FabricSqlCredentials, keyword: string): void {
	if (!credentials.allowWriteOperations) {
		throw new ReadOnlySqlError(keyword);
	}
}
