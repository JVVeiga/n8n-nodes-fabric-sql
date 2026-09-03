/**
 * Typed failures raised by the pure `core/` modules.
 *
 * These carry machine-readable fields so `transport/errors.ts` can turn them into
 * n8n node errors without re-parsing message strings.
 */

export class FabricSqlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** The submitted query was empty or whitespace only. */
export class EmptySqlError extends FabricSqlError {
	constructor() {
		super('Query is empty.');
	}
}

/** A non-read statement was submitted while write operations are disabled. */
export class ReadOnlySqlError extends FabricSqlError {
	constructor(readonly keyword: string) {
		super(
			`This endpoint is read-only (${keyword} is not allowed). Lakehouse SQL analytics endpoints ` +
				'accept SELECT only; writes require a Fabric Warehouse and "Allow Write Operations" ' +
				'enabled on the credential.',
		);
	}
}

/** The number of `?` placeholders did not match the number of supplied values. */
export class PlaceholderCountError extends FabricSqlError {
	constructor(
		readonly expected: number,
		readonly received: number,
	) {
		super(
			`Query has ${expected} '?' placeholder${expected === 1 ? '' : 's'} but ${received} ` +
				`value${received === 1 ? ' was' : 's were'} provided.`,
		);
	}
}

/** The server field was blank, or looked like something other than a bare hostname. */
export class InvalidServerError extends FabricSqlError {}

/** An identifier could not be quoted safely (blank, or too many qualified parts). */
export class InvalidIdentifierError extends FabricSqlError {}
