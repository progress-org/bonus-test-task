import { Op } from 'sequelize';
import { sequelize } from '../db';
import { BonusTransaction } from '../models/BonusTransaction';

type AppError = Error & { status?: number };

function createAppError(message: string, status: number): AppError {
  const error = new Error(message) as AppError;
  error.status = status;
  return error;
}

export async function getUserBalance(userId: string): Promise<number> {
  const accruals = await BonusTransaction.findAll({
    where: {
      user_id: userId,
      type: 'accrual',
      remainder: { [Op.gt]: 0 },
      [Op.or]: [
        { expires_at: null },
        { expires_at: { [Op.gt]: new Date() } }
      ]
    },
  });

  return accruals.reduce((sum, tx) => sum + (tx.remainder || 0), 0);
}

// Обертка для обработки race conditions при создании записи с одинаковым request_id
export async function spendBonus(userId: string, amount: number, requestId: string): Promise<{ success: boolean; duplicated: boolean }> {
  try {
    return await executeSpend(userId, amount, requestId);
  } catch (error: any) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      // Если параллельный запрос успел закоммитить тот же requestId долю секунды назад,
      // мы ловим ошибку уникального индекса и повторяем чтение
      return await executeSpend(userId, amount, requestId);
    }
    throw error;
  }
}

async function executeSpend(userId: string, amount: number, requestId: string): Promise<{ success: boolean; duplicated: boolean }> {
  return await sequelize.transaction(async (transaction) => {
    // 1. Проверка идемпотентности
    const existingSpends = await BonusTransaction.findAll({
      where: { user_id: userId, request_id: requestId },
      transaction
    });

    if (existingSpends.length > 0) {
      const totalSpent = existingSpends.reduce((sum, tx) => sum + tx.amount, 0);
      if (totalSpent === amount) {
        return { success: true, duplicated: true };
      }
      throw createAppError('Conflict: Different payload for same requestId', 409);
    }

    // 2. Блокировка строк для предотвращения ухода в минус
    const accruals = await BonusTransaction.findAll({
      where: {
        user_id: userId,
        type: 'accrual',
        remainder: { [Op.gt]: 0 },
        [Op.or]: [
          { expires_at: null },
          { expires_at: { [Op.gt]: new Date() } }
        ]
      },
      order: [['expires_at', 'ASC NULLS LAST'], ['created_at', 'ASC']],
      lock: transaction.LOCK.UPDATE,
      transaction
    });

    const totalAvailable = accruals.reduce((sum, tx) => sum + (tx.remainder || 0), 0);

    if (totalAvailable < amount) {
      throw createAppError('Not enough bonus', 400);
    }

    // 3. Списание с остатков
    let remainingToSpend = amount;
    for (const accrual of accruals) {
      if (remainingToSpend <= 0) break;

      const availableInAccrual = accrual.remainder || 0;
      const spendAmount = Math.min(availableInAccrual, remainingToSpend);

      accrual.remainder = availableInAccrual - spendAmount;
      await accrual.save({ transaction });

      await BonusTransaction.create({
        user_id: userId,
        type: 'spend',
        amount: spendAmount,
        expires_at: null,
        request_id: requestId,
      }, { transaction });

      remainingToSpend -= spendAmount;
    }

    return { success: true, duplicated: false };
  });
}