import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

/** Decrypted shape of the `fabricSqlApi` credential. */
export interface FabricSqlCredentials {
	server: string;
	database: string;
	tenantId: string;
	clientId: string;
	clientSecret: string;
	connectTimeout: number;
	requestTimeout: number;
	allowWriteOperations: boolean;
}

/**
 * A SQL statement plus the values to bind to it.
 *
 * Values live here and never in `sql` — every builder in `core/` returns this shape so that
 * `transport/connection.ts` can hand each value to the driver as a real TDS parameter.
 */
export interface BuiltQuery {
	sql: string;
	parameters: Record<string, unknown>;
}

export interface ColumnMetadataLike {
	index: number;
	name: string;
}

/**
 * Structural subset of `mssql.IResult` that `core/` depends on.
 *
 * Declared here so the pure modules never import `mssql`, which keeps them testable
 * without a driver and without a database.
 *
 * Rows are arrays, not keyed objects: queries run with the driver's `arrayRowMode`, because
 * a keyed row drops columns whose names collide — `SELECT a.id, b.id` would silently lose one
 * of them. The parallel `columns` metadata carries the real names, in order.
 */
export interface QueryResultLike {
	recordsets: Array<Array<unknown[]>>;
	rowsAffected: number[];
	columns: ColumnMetadataLike[][];
}

export type WhereOperator =
	| 'equal'
	| 'notEqual'
	| 'greaterThan'
	| 'greaterThanOrEqual'
	| 'lessThan'
	| 'lessThanOrEqual'
	| 'like'
	| 'isNull'
	| 'isNotNull';

export interface WhereCondition {
	column: string;
	operator: WhereOperator;
	value?: unknown;
}

export interface SelectOptions {
	table: string;
	columns?: string[];
	limit?: number;
	where?: WhereCondition[];
}

/** Minimal request surface used by `runQuery`, so tests can pass a stub instead of a driver. */
export interface RequestLike {
	arrayRowMode?: boolean | null;
	input(name: string, value: unknown): unknown;
	query(sql: string): Promise<QueryResultLike>;
}

/** Minimal pool surface used by the operation handlers. */
export interface PoolLike {
	request(): RequestLike;
	close(): Promise<unknown> | unknown;
}

/**
 * One `resource:operation` pair.
 *
 * Handlers receive an already-open pool: the node opens exactly one per execution and closes it
 * in a `finally`, so no handler is responsible for connection lifetime.
 */
export type OperationHandler = (
	ctx: IExecuteFunctions,
	pool: PoolLike,
	credentials: FabricSqlCredentials,
	itemIndex: number,
) => Promise<INodeExecutionData[]>;

/** Result of the best-effort Fabric REST bootstrap. Never an exception. */
export type WarmupOutcome = { ok: true } | { ok: false; detail: string };

/** A row of input data destined for a write operation. */
export type WritableRow = IDataObject;
