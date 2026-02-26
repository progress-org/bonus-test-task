import { NextFunction, Request, Response } from 'express';

import { bonusQueue } from '../queue';
import { spendBonus } from '../services/bonus.service';

type AppError = Error & { status?: number };

function createAppError(message: string, status: number): AppError {
  const error = new Error(message) as AppError;
  error.status = status;
  return error;
}

export async function spendUserBonus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const amount = Number(req.body?.amount);
    const requestId = (req.headers['idempotency-key'] || req.body?.requestId) as string;

    if (!requestId) {
      throw createAppError('requestId or Idempotency-Key header is required', 400);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw createAppError('amount must be a positive integer', 400);
    }

    const result = await spendBonus(req.params.id, amount, requestId);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function enqueueExpireAccrualsJob(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await bonusQueue.add('expireAccruals', {
      createdAt: new Date().toISOString(),
    }, {
      jobId: 'expire-accruals', // Строгая защита от дублей таски в очереди
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 }
    });

    res.json({ queued: true });
  } catch (error) {
    next(error);
  }
}
