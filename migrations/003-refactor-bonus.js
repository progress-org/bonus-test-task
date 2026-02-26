'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Удаляем старый глобальный индекс
    await queryInterface.removeIndex('bonus_transactions', 'bonus_transactions_request_id_uq');

    // 2. Создаем уникальный индекс (user_id, request_id), исключая NULL
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX bonus_transactions_user_request_id_uq 
      ON bonus_transactions (user_id, request_id) 
      WHERE request_id IS NOT NULL;
    `);

    // 3. Добавляем колонку остатка
    await queryInterface.addColumn('bonus_transactions', 'remainder', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    // 4. Заполняем remainder для существующих начислений
    await queryInterface.sequelize.query(`
      UPDATE bonus_transactions SET remainder = amount WHERE type = 'accrual';
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('bonus_transactions', 'remainder');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS bonus_transactions_user_request_id_uq;');
    await queryInterface.addIndex('bonus_transactions', ['request_id'], {
      name: 'bonus_transactions_request_id_uq',
      unique: true,
    });
  },
};