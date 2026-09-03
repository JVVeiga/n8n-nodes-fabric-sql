import type { IDataObject, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

/**
 * What makes a tool's calls VISIBLE under its node on the canvas.
 *
 * Without this the tool runs, answers the agent correctly, and leaves no trace in the
 * execution — the node sits there looking untouched while the model quietly queries the
 * lakehouse. Which query ran, and what came back, is most of what you need when an agent
 * reaches a wrong conclusion, so a tool that does not report is a tool you cannot debug.
 *
 * Every call is guarded: `addInputData` throws outside a real execution (an editor probe, for
 * instance), and logging must never be the thing that fails a run.
 */
export type ToolRunLog = {
	start: (payload: Record<string, unknown>) => number;
	end: (index: number, payload: Record<string, unknown>) => void;
	/** Exists so a failed call is CLOSED as failed rather than left hanging open. */
	error: (index: number, error: unknown) => void;
};

export function toolRunLog(ctx: ISupplyDataFunctions): ToolRunLog {
	return {
		start: (payload) => {
			try {
				return ctx.addInputData(NodeConnectionTypes.AiTool, [[{ json: payload as IDataObject }]])
					.index;
			} catch {
				return -1;
			}
		},
		end: (index, payload) => {
			if (index < 0) return;

			try {
				void ctx.addOutputData(NodeConnectionTypes.AiTool, index, [
					[{ json: payload as IDataObject }],
				]);
			} catch {
				// Logging must never fail the run.
			}
		},
		error: (index, error) => {
			if (index < 0) return;

			try {
				const wrapped =
					error instanceof NodeOperationError
						? error
						: new NodeOperationError(ctx.getNode(), error as Error);
				void ctx.addOutputData(NodeConnectionTypes.AiTool, index, wrapped);
			} catch {
				// Same.
			}
		},
	};
}
