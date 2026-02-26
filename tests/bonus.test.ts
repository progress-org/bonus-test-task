import request from 'supertest';
import app from '../src/app';
import { sequelize } from '../src/db';
import { User } from '../src/models/User';
import { BonusTransaction } from '../src/models/BonusTransaction';
import { startExpireAccrualsWorker, bonusQueue } from '../src/queue';
import { redis } from '../src/redis';

let testUser: User;
let worker: any; // Сюда сохраним инстанс воркера

beforeAll(async () => {
  await sequelize.sync({ force: true });
  worker = startExpireAccrualsWorker(); // Запускаем воркер один раз перед всеми тестами
});

beforeEach(async () => {
  await BonusTransaction.destroy({ where: {} });
  await User.destroy({ where: {} });

  testUser = await User.create({ name: 'Test User' });
});

afterAll(async () => {
  if (worker) {
    await worker.close(true); // true означает принудительное закрытие
    await worker.disconnect();
  }
  await bonusQueue.close();
  await bonusQueue.disconnect();
  await redis.quit();
  await sequelize.close();
});

describe('Bonus System API', () => {

  describe('1. Идемпотентность', () => {
    it('Повторный запрос на списание с тем же requestId не создает второе списание', async () => {
      // Даем юзеру 100 бонусов
      await BonusTransaction.create({
        user_id: testUser.id,
        type: 'accrual',
        amount: 100,
        remainder: 100,
        expires_at: new Date(Date.now() + 1000000), // годен
      });

      const payload = { amount: 50, requestId: 'unique-req-123' };

      // Первый запрос
      const res1 = await request(app).post(`/users/${testUser.id}/spend`).send(payload);
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ success: true, duplicated: false });

      // Второй запрос с ТЕМ ЖЕ requestId и payload
      const res2 = await request(app).post(`/users/${testUser.id}/spend`).send(payload);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ success: true, duplicated: true }); // Отдает 200 и duplicated: true по ТЗ

      // Третий запрос с ТЕМ ЖЕ requestId, но ДРУГИМ payload (amount: 60)
      const res3 = await request(app)
        .post(`/users/${testUser.id}/spend`)
        .send({ amount: 60, requestId: 'unique-req-123' });
      expect(res3.status).toBe(409); // Отдает 409 Conflict по ТЗ

      // Проверяем в БД, что списание было только одно
      const spends = await BonusTransaction.findAll({ where: { type: 'spend' } });
      expect(spends.length).toBe(1);
      expect(spends[0].amount).toBe(50);
    });
  });

  describe('2. Просроченные начисления', () => {
    it('Начисление с истекшим сроком действия не учитывается в доступном балансе', async () => {
      // Даем юзеру 100 бонусов, но они УЖЕ просрочены
      await BonusTransaction.create({
        user_id: testUser.id,
        type: 'accrual',
        amount: 100,
        remainder: 100,
        expires_at: new Date(Date.now() - 1000000), // В прошлом
      });

      // Пытаемся списать 50
      const res = await request(app)
        .post(`/users/${testUser.id}/spend`)
        .send({ amount: 50, requestId: 'req-expired-test' });

      // Должно вернуть 400 Not enough bonus
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not enough bonus/i);
    });
  });

  describe('3. Race Conditions (Конкурентные запросы)', () => {
    it('Конкурентные списания не приводят к отрицательному балансу', async () => {
      // Даем юзеру ровно 100 бонусов
      await BonusTransaction.create({
        user_id: testUser.id,
        type: 'accrual',
        amount: 100,
        remainder: 100,
        expires_at: new Date(Date.now() + 1000000),
      });

      // Делаем 3 одновременных запроса на списание по 100 бонусов
      // У каждого уникальный requestId, чтобы они не отбились по идемпотентности
      const req1 = request(app).post(`/users/${testUser.id}/spend`).send({ amount: 100, requestId: 'race-1' });
      const req2 = request(app).post(`/users/${testUser.id}/spend`).send({ amount: 100, requestId: 'race-2' });
      const req3 = request(app).post(`/users/${testUser.id}/spend`).send({ amount: 100, requestId: 'race-3' });

      const responses = await Promise.all([req1, req2, req3]);
      
      const statuses = responses.map(r => r.status);
      
      // Только один должен пройти успешно (200), остальные отвалятся с нехваткой средств (400)
      const successCount = statuses.filter(s => s === 200).length;
      const failCount = statuses.filter(s => s === 400).length;

      expect(successCount).toBe(1);
      expect(failCount).toBe(2);

      // Проверяем, что в БД баланс (remainder) не ушел в минус
      const accruals = await BonusTransaction.findAll({ where: { type: 'accrual' } });
      expect(accruals[0].remainder).toBe(0); // Потрачено подчистую, без минуса
    });
  });

  describe('4. Очередь (Worker)', () => {
    it('Повторная обработка задачи не создает дубли бизнес-эффектов', async () => {
      // Даем юзеру просроченное начисление
      const expiredAccrual = await BonusTransaction.create({
        user_id: testUser.id,
        type: 'accrual',
        amount: 200,
        remainder: 200, // Остаток 200
        expires_at: new Date(Date.now() - 100000), // В прошлом
      });

      // Имитируем выполнение джобы (вызываем логику напрямую для теста)
      // В реальном тесте можно дождаться выполнения через BullMQ, но вызов логики надежнее для юнит/интеграционных тестов
      const mockJob = { 
        name: 'expireAccruals', 
        id: 'expire-accruals',
        moveToCompleted: async () => {}, 
        moveToFailed: async () => {},
      } as any;
      
      await worker.processJob(mockJob, 'bonus-test-token');

      // Проверяем, что создалось списание с корректным request_id
      let spends = await BonusTransaction.findAll({ where: { type: 'spend' } });
      expect(spends.length).toBe(1);
      expect(spends[0].amount).toBe(200);
      expect(spends[0].request_id).toBe(`expire:${expiredAccrual.id}`);
      
      // Проверяем, что остаток начисления обнулился
      const updatedAccrual = await BonusTransaction.findByPk(expiredAccrual.id);
      expect(updatedAccrual?.remainder).toBe(0);

      // ИМИТИРУЕМ ПОВТОРНУЮ ОБРАБОТКУ (дубль)      
      await worker.processJob(mockJob, 'bonus-test-token');

      // Проверяем, что количество списаний не увеличилось
      spends = await BonusTransaction.findAll({ where: { type: 'spend' } });
      expect(spends.length).toBe(1); // Всё еще 1! Защита отработала.
    });
  });
});