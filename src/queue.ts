import { Queue, Worker } from 'bullmq';

import { redis } from './redis';
import { BonusTransaction } from './models/BonusTransaction';
import { Op } from 'sequelize';
import { sequelize } from './db';

const queueConnection = redis.duplicate();

export const bonusQueue = new Queue('bonusQueue', {
  connection: queueConnection,
});

let expireAccrualsWorker: Worker | null = null;

export function startExpireAccrualsWorker(): Worker {
  if (expireAccrualsWorker) return expireAccrualsWorker;

  expireAccrualsWorker = new Worker(
    'bonusQueue',
    async (job) => {
      if (job.name === 'expireAccruals') {
        const expiredAccruals = await BonusTransaction.findAll({
          where: {
            type: 'accrual',
            remainder: { [Op.gt]: 0 },
            expires_at: { [Op.lt]: new Date() }
          }
        });

        for (const accrual of expiredAccruals) {
          const reqId = `expire:${accrual.id}`;
          try {
            await sequelize.transaction(async (transaction) => {
              const lockedAccrual = await BonusTransaction.findOne({
                where: { id: accrual.id },
                lock: transaction.LOCK.UPDATE,
                transaction
              });

              if (!lockedAccrual || (lockedAccrual.remainder || 0) <= 0) return;

              const existingSpend = await BonusTransaction.findOne({
                where: { request_id: reqId },
                transaction
              });

              if (existingSpend) return; // Уже списано ранее

              const amountToExpire = lockedAccrual.remainder!;
              lockedAccrual.remainder = 0;
              await lockedAccrual.save({ transaction });

              await BonusTransaction.create({
                user_id: lockedAccrual.user_id,
                type: 'spend',
                amount: amountToExpire,
                expires_at: null,
                request_id: reqId
              }, { transaction });
            });
          } catch (err) {
            console.error(`[worker] failed to expire accrual ${accrual.id}`, err);
            throw err; // Пробрасываем ошибку для retry в BullMQ
          }
        }
      }
    },
    { connection: redis.duplicate() },
  );

  expireAccrualsWorker.on('failed', (job, err) => {
    console.error(`[worker] failed, jobId=${job?.id}`, err);
  });

  return expireAccrualsWorker;
}
