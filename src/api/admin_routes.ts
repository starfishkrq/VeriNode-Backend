import type { Request, Response } from 'express';
import { TwoPhaseController } from '../core/state/two_phase_controller';
import { createLogger } from '../diagnostics/logger';

/**
 * POST /internal/state/resolve-tentative/:nodeId
 * Body: { "action": "commit" | "rollback" }
 */
export class AdminRoutes {
  private readonly log = createLogger('admin_routes');

  constructor(private readonly controller: TwoPhaseController) {}

  async resolveTentativeState(req: Request, res: Response) {
    const { nodeId } = req.params;
    const { action } = req.body;

    if (!nodeId) {
      return res.status(400).json({ error: 'nodeId parameter is required' });
    }

    if (action !== 'commit' && action !== 'rollback') {
      return res.status(400).json({ error: 'action must be "commit" or "rollback"' });
    }

    try {
      const result = await this.controller.resolveTentative(nodeId as string, action);

      if (!result.resolved) {
        return res.status(404).json({
          error: `No PENDING tentative state found for node ${nodeId}`,
        });
      }

      this.log.info('Admin resolved tentative state', {
        node_id: nodeId as string,
        action,
        outcome: result.outcome,
      });

      return res.json({
        message: `Successfully ${action === 'commit' ? 'force-committed' : 'rolled back'} tentative state for node ${nodeId}`,
        outcome: result.outcome,
      });
    } catch (error: any) {
      this.log.error('Error resolving tentative state', {
        node_id: nodeId,
        action,
        error: error.message,
      });
      return res.status(500).json({
        error: 'Internal Server Error',
        details: error.message,
      });
    }
  }
}
