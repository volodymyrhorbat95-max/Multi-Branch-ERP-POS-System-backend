const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const {
  CashRegister, RegisterSession, Branch, User, Sale, SalePayment,
  PaymentMethod, DailyReport, Alert, CashWithdrawal, sequelize
} = require('../database/models');
const { success, created, paginated } = require('../utils/apiResponse');
const { NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { parsePagination, generateSessionNumber, getBusinessDate, isPastClosingTime, formatDecimal } = require('../utils/helpers');
const { EVENTS } = require('../socket');
const logger = require('../utils/logger');

// ===== Helper Functions =====

/**
 * Calculate total from denomination breakdown
 */
const calculateDenominationTotal = (denominations) => {
  if (!denominations) return 0;

  return (
    (denominations.bills_1000 || 0) * 1000 +
    (denominations.bills_500 || 0) * 500 +
    (denominations.bills_200 || 0) * 200 +
    (denominations.bills_100 || 0) * 100 +
    (denominations.bills_50 || 0) * 50 +
    (denominations.bills_20 || 0) * 20 +
    (denominations.bills_10 || 0) * 10 +
    parseFloat(denominations.coins || 0)
  );
};

// ===== Cash Register Controllers =====

/**
 * Get all cash registers
 * GET /api/v1/registers
 */
exports.getAllRegisters = async (req, res, next) => {
  try {
    const { branch_id, is_active } = req.query;

    const where = {};
    if (branch_id) where.branch_id = branch_id;
    if (is_active !== undefined) where.is_active = is_active === 'true';

    const registers = await CashRegister.findAll({
      where,
      include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }],
      order: [['branch_id', 'ASC'], ['register_number', 'ASC']]
    });

    return success(res, registers);
  } catch (error) {
    next(error);
  }
};

/**
 * Get cash register by ID
 * GET /api/v1/registers/:id
 */
exports.getRegisterById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const register = await CashRegister.findByPk(id, {
      include: [{ model: Branch, as: 'branch' }]
    });

    if (!register) {
      throw new NotFoundError('Cash register not found');
    }

    // Get current session
    const currentSession = await RegisterSession.findOne({
      where: { register_id: id, status: 'OPEN' },
      include: [{ model: User, as: 'opener', attributes: ['first_name', 'last_name'] }]
    });

    return success(res, {
      ...register.toJSON(),
      current_session: currentSession
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create new cash register
 * POST /api/v1/registers
 */
exports.createRegister = async (req, res, next) => {
  try {
    const { branch_id, register_number, name } = req.body;

    const register = await CashRegister.create({
      id: uuidv4(),
      branch_id,
      register_number,
      name: name || `Caja ${register_number}`
    });

    return created(res, register);
  } catch (error) {
    next(error);
  }
};

/**
 * Update cash register
 * PUT /api/v1/registers/:id
 */
exports.updateRegister = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, is_active } = req.body;

    const register = await CashRegister.findByPk(id);

    if (!register) {
      throw new NotFoundError('Cash register not found');
    }

    await register.update({ name, is_active });

    return success(res, register);
  } catch (error) {
    next(error);
  }
};

// ===== Register Session Controllers =====

/**
 * Get register sessions with filters
 * GET /api/v1/registers/sessions/list
 */
exports.getSessions = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { branch_id, register_id, status, business_date } = req.query;

    const where = {};
    if (branch_id) where.branch_id = branch_id;
    if (register_id) where.register_id = register_id;
    if (status) where.status = status;
    if (business_date) where.business_date = business_date;

    const { count, rows } = await RegisterSession.findAndCountAll({
      where,
      include: [
        { model: CashRegister, as: 'register', attributes: ['register_number', 'name'] },
        { model: Branch, as: 'branch', attributes: ['name', 'code'] },
        { model: User, as: 'opener', attributes: ['first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['first_name', 'last_name'] }
      ],
      order: [['opened_at', 'DESC']],
      limit,
      offset
    });

    return paginated(res, rows, { page, limit, total_items: count });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current open session for register
 * GET /api/v1/registers/:registerId/current-session
 */
exports.getCurrentSession = async (req, res, next) => {
  try {
    const { registerId } = req.params;

    const session = await RegisterSession.findOne({
      where: { register_id: registerId, status: 'OPEN' },
      include: [
        { model: User, as: 'opener', attributes: ['first_name', 'last_name'] }
      ]
    });

    if (!session) {
      return success(res, null, 'No open session');
    }

    return success(res, session);
  } catch (error) {
    next(error);
  }
};

/**
 * Open a new register session
 * POST /api/v1/registers/:registerId/open
 */
exports.openSession = async (req, res, next) => {
  try {
    const { registerId } = req.params;
    const { shift_type, opening_cash, opening_notes, opening_denominations, local_id } = req.body;

    // Check register exists
    const register = await CashRegister.findByPk(registerId, {
      include: [{ model: Branch, as: 'branch' }]
    });

    if (!register) {
      throw new NotFoundError('Cash register not found');
    }

    // Check no open session exists
    const existingSession = await RegisterSession.findOne({
      where: { register_id: registerId, status: 'OPEN' }
    });

    if (existingSession) {
      throw new BusinessError('Register already has an open session', 'E401');
    }

    // Validate denomination breakdown matches total
    if (opening_denominations) {
      const denominationTotal = calculateDenominationTotal(opening_denominations);
      if (Math.abs(denominationTotal - opening_cash) > 0.01) {
        throw new BusinessError(
          `Denomination breakdown (${formatDecimal(denominationTotal)}) does not match opening cash total (${formatDecimal(opening_cash)})`,
          'E403'
        );
      }
    }

    const businessDate = getBusinessDate();

    const session = await RegisterSession.create({
      id: uuidv4(),
      register_id: registerId,
      branch_id: register.branch_id,
      session_number: generateSessionNumber(register.register_number, shift_type),
      shift_type,
      business_date: businessDate,
      opened_by: req.user.id,
      opened_at: new Date(),
      opening_cash,
      opening_notes,
      // Denomination breakdown
      opening_bills_1000: opening_denominations?.bills_1000 || 0,
      opening_bills_500: opening_denominations?.bills_500 || 0,
      opening_bills_200: opening_denominations?.bills_200 || 0,
      opening_bills_100: opening_denominations?.bills_100 || 0,
      opening_bills_50: opening_denominations?.bills_50 || 0,
      opening_bills_20: opening_denominations?.bills_20 || 0,
      opening_bills_10: opening_denominations?.bills_10 || 0,
      opening_coins: opening_denominations?.coins || 0,
      status: 'OPEN',
      local_id,
      synced_at: new Date()
    });

    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emitToBranch(register.branch_id, EVENTS.SESSION_OPENED, {
        session_id: session.id,
        register_name: register.name,
        opened_by: `${req.user.first_name} ${req.user.last_name}`,
        shift_type
      });
    }

    return created(res, session);
  } catch (error) {
    next(error);
  }
};

/**
 * Close register session (Blind Closing)
 * POST /api/v1/registers/sessions/:sessionId/close
 */
exports.closeSession = async (req, res, next) => {
  const t = await sequelize.transaction();

  try {
    const { sessionId } = req.params;
    const {
      declared_cash,
      declared_card,
      declared_qr,
      declared_transfer,
      closing_notes,
      closing_denominations
    } = req.body;

    const session = await RegisterSession.findByPk(sessionId, {
      include: [
        { model: Branch, as: 'branch' },
        { model: CashRegister, as: 'register' }
      ]
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.status !== 'OPEN') {
      throw new BusinessError('Session is not open', 'E402');
    }

    // Validate closing denomination breakdown matches declared cash
    if (closing_denominations) {
      const denominationTotal = calculateDenominationTotal(closing_denominations);
      if (Math.abs(denominationTotal - declared_cash) > 0.01) {
        throw new BusinessError(
          `Closing denomination breakdown (${formatDecimal(denominationTotal)}) does not match declared cash (${formatDecimal(declared_cash)})`,
          'E404'
        );
      }
    }

    // Calculate expected amounts from sales
    const sales = await Sale.findAll({
      where: { session_id: sessionId, status: 'COMPLETED' },
      include: [{
        model: SalePayment,
        as: 'payments',
        include: [{ model: PaymentMethod, as: 'payment_method' }]
      }]
    });

    // Get withdrawals for this session
    const withdrawals = await CashWithdrawal.findAll({
      where: { session_id: sessionId }
    });
    const totalWithdrawals = withdrawals.reduce((sum, w) => sum + parseFloat(w.amount), 0);

    // Initialize expected amounts with opening cash
    let expected_cash = parseFloat(session.opening_cash);
    let expected_card = 0;
    let expected_qr = 0;
    let expected_transfer = 0;

    // Sum up payments by method
    for (const sale of sales) {
      for (const payment of sale.payments) {
        const code = payment.payment_method.code;
        const amount = parseFloat(payment.amount);

        switch (code) {
          case 'CASH':
            expected_cash += amount;
            break;
          case 'DEBIT':
          case 'CREDIT':
            expected_card += amount;
            break;
          case 'QR':
            expected_qr += amount;
            break;
          case 'TRANSFER':
            expected_transfer += amount;
            break;
        }
      }
    }

    // Subtract withdrawals from expected cash
    expected_cash -= totalWithdrawals;

    // Calculate discrepancies
    const discrepancy_cash = declared_cash - expected_cash;
    const discrepancy_card = declared_card - expected_card;
    const discrepancy_qr = declared_qr - expected_qr;
    const discrepancy_transfer = declared_transfer - expected_transfer;
    const total_discrepancy = discrepancy_cash + discrepancy_card + discrepancy_qr + discrepancy_transfer;

    // Update session with closing data
    await session.update({
      closed_by: req.user.id,
      closed_at: new Date(),
      declared_cash,
      declared_card,
      declared_qr,
      declared_transfer,
      expected_cash,
      expected_card,
      expected_qr,
      expected_transfer,
      discrepancy_cash,
      discrepancy_card,
      discrepancy_qr,
      discrepancy_transfer,
      total_discrepancy,
      // Closing denomination breakdown
      closing_bills_1000: closing_denominations?.bills_1000 || null,
      closing_bills_500: closing_denominations?.bills_500 || null,
      closing_bills_200: closing_denominations?.bills_200 || null,
      closing_bills_100: closing_denominations?.bills_100 || null,
      closing_bills_50: closing_denominations?.bills_50 || null,
      closing_bills_20: closing_denominations?.bills_20 || null,
      closing_bills_10: closing_denominations?.bills_10 || null,
      closing_coins: closing_denominations?.coins || null,
      status: 'CLOSED',
      closing_notes
    }, { transaction: t });

    // Update or create daily report
    const [dailyReport] = await DailyReport.findOrCreate({
      where: {
        branch_id: session.branch_id,
        business_date: session.business_date
      },
      defaults: {
        id: uuidv4(),
        branch_id: session.branch_id,
        business_date: session.business_date
      },
      transaction: t
    });

    // Update daily report totals
    await dailyReport.increment({
      total_cash: expected_cash - parseFloat(session.opening_cash),
      total_card: expected_card,
      total_qr: expected_qr,
      total_transfer: expected_transfer,
      total_discrepancy: total_discrepancy,
      transaction_count: sales.length
    }, { transaction: t });

    await t.commit();

    // Check petty cash fund - alert if cash is below petty cash amount
    const pettyCashAmount = parseFloat(session.branch.petty_cash_amount || 0);
    if (pettyCashAmount > 0 && expected_cash < pettyCashAmount) {
      await Alert.create({
        id: uuidv4(),
        alert_type: 'LOW_PETTY_CASH',
        severity: 'HIGH',
        branch_id: session.branch_id,
        user_id: req.user.id,
        title: 'Fondo de caja bajo',
        message: `Efectivo en caja ($${formatDecimal(expected_cash)}) está por debajo del fondo de caja configurado ($${formatDecimal(pettyCashAmount)}). Retiros totales: $${formatDecimal(totalWithdrawals)}`,
        reference_type: 'SESSION',
        reference_id: session.id
      });

      // Emit alert to owners
      const io = req.app.get('io');
      if (io) {
        io.emitToOwners(EVENTS.ALERT_CREATED, {
          type: 'LOW_PETTY_CASH',
          severity: 'HIGH',
          branch_name: session.branch.name,
          current_cash: expected_cash,
          petty_cash_amount: pettyCashAmount
        }, session.branch_id);
      }
    }

    // Create alert if significant discrepancy
    if (Math.abs(total_discrepancy) > 100) {
      await Alert.create({
        id: uuidv4(),
        alert_type: 'CASH_DISCREPANCY',
        severity: Math.abs(total_discrepancy) > 500 ? 'CRITICAL' : 'HIGH',
        branch_id: session.branch_id,
        user_id: req.user.id,
        title: `Diferencia de caja: $${formatDecimal(total_discrepancy)}`,
        message: `Cierre de ${session.register.name} con diferencia de $${formatDecimal(total_discrepancy)}. Efectivo: $${formatDecimal(discrepancy_cash)}, Tarjeta: $${formatDecimal(discrepancy_card)}, QR: $${formatDecimal(discrepancy_qr)}, Transferencia: $${formatDecimal(discrepancy_transfer)}`,
        reference_type: 'SESSION',
        reference_id: session.id
      });

      // Emit alert to owners
      const io = req.app.get('io');
      if (io) {
        io.emitToOwners(EVENTS.ALERT_CREATED, {
          type: 'CASH_DISCREPANCY',
          severity: Math.abs(total_discrepancy) > 500 ? 'CRITICAL' : 'HIGH',
          branch_name: session.branch.name,
          amount: total_discrepancy
        }, session.branch_id);
      }
    }

    // Emit session closed event
    const io = req.app.get('io');
    if (io) {
      io.emitToBranch(session.branch_id, EVENTS.SESSION_CLOSED, {
        session_id: session.id,
        register_name: session.register.name,
        closed_by: `${req.user.first_name} ${req.user.last_name}`,
        has_discrepancy: Math.abs(total_discrepancy) > 0
      });
    }

    return success(res, {
      ...session.toJSON(),
      sales_count: sales.length,
      sales_total: sales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0)
    });
  } catch (error) {
    await t.rollback();
    next(error);
  }
};

/**
 * Reopen a closed session (requires manager authorization)
 * POST /api/v1/registers/sessions/:sessionId/reopen
 */
exports.reopenSession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { reason } = req.body;

    const session = await RegisterSession.findByPk(sessionId, {
      include: [{ model: Branch, as: 'branch' }]
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.status !== 'CLOSED') {
      throw new BusinessError('Only closed sessions can be reopened', 'E402');
    }

    // Update session
    await session.update({
      status: 'REOPENED',
      reopened_by: req.authorized_by?.id || req.user.id,
      reopened_at: new Date(),
      reopen_reason: reason
    });

    // Create alert
    await Alert.create({
      id: uuidv4(),
      alert_type: 'REOPEN_REGISTER',
      severity: 'HIGH',
      branch_id: session.branch_id,
      user_id: req.user.id,
      title: `Caja reabierta en ${session.branch.name}`,
      message: `Sesión ${session.session_number} fue reabierta. Motivo: ${reason}`,
      reference_type: 'SESSION',
      reference_id: session.id
    });

    return success(res, session);
  } catch (error) {
    next(error);
  }
};

/**
 * Get session by ID with details
 * GET /api/v1/registers/sessions/:sessionId
 */
exports.getSessionById = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    const session = await RegisterSession.findByPk(sessionId, {
      include: [
        { model: CashRegister, as: 'register' },
        { model: Branch, as: 'branch' },
        { model: User, as: 'opener', attributes: ['first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['first_name', 'last_name'] },
        { model: User, as: 'reopener', attributes: ['first_name', 'last_name'] }
      ]
    });

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    return success(res, session);
  } catch (error) {
    next(error);
  }
};

/**
 * Get session summary with payment breakdown
 * GET /api/v1/registers/sessions/:sessionId/summary
 */
exports.getSessionSummary = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    const session = await RegisterSession.findByPk(sessionId);

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    // Get sales summary
    const sales = await Sale.findAll({
      where: { session_id: sessionId },
      include: [{
        model: SalePayment,
        as: 'payments',
        include: [{ model: PaymentMethod, as: 'payment_method' }]
      }]
    });

    const completedSales = sales.filter((s) => s.status === 'COMPLETED');
    const voidedSales = sales.filter((s) => s.status === 'VOIDED');

    // Payment breakdown
    const paymentSummary = {};
    for (const sale of completedSales) {
      for (const payment of sale.payments) {
        const methodName = payment.payment_method.name;
        if (!paymentSummary[methodName]) {
          paymentSummary[methodName] = { expected: 0, declared: null, discrepancy: null };
        }
        paymentSummary[methodName].expected += parseFloat(payment.amount);
      }
    }

    // Add declared values if session is closed
    if (session.status === 'CLOSED') {
      if (paymentSummary['Efectivo'] || session.expected_cash > 0) {
        paymentSummary['Efectivo'] = paymentSummary['Efectivo'] || { expected: 0 };
        paymentSummary['Efectivo'].expected = parseFloat(session.expected_cash);
        paymentSummary['Efectivo'].declared = parseFloat(session.declared_cash);
        paymentSummary['Efectivo'].discrepancy = parseFloat(session.discrepancy_cash);
      }
    }

    return success(res, {
      session: session.toJSON(),
      sales_count: completedSales.length,
      sales_total: completedSales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0),
      voided_count: voidedSales.length,
      voided_total: voidedSales.reduce((sum, s) => sum + parseFloat(s.total_amount), 0),
      payment_summary: Object.entries(paymentSummary).map(([method, data]) => ({
        payment_method: method,
        ...data
      }))
    });
  } catch (error) {
    next(error);
  }
};

// ===== Daily Report Controllers =====

/**
 * Get daily reports
 * GET /api/v1/registers/daily-reports/list
 */
exports.getDailyReports = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { branch_id, from_date, to_date, is_finalized } = req.query;

    const where = {};
    if (branch_id) where.branch_id = branch_id;
    if (is_finalized !== undefined) where.is_finalized = is_finalized === 'true';

    if (from_date || to_date) {
      where.business_date = {};
      if (from_date) where.business_date[Op.gte] = from_date;
      if (to_date) where.business_date[Op.lte] = to_date;
    }

    const { count, rows } = await DailyReport.findAndCountAll({
      where,
      include: [{ model: Branch, as: 'branch', attributes: ['name', 'code'] }],
      order: [['business_date', 'DESC']],
      limit,
      offset
    });

    return paginated(res, rows, { page, limit, total_items: count });
  } catch (error) {
    next(error);
  }
};

/**
 * Get daily report for specific branch and date
 * GET /api/v1/registers/daily-reports/:branchId/:date
 */
exports.getDailyReportByDate = async (req, res, next) => {
  try {
    const { branchId, date } = req.params;

    const report = await DailyReport.findOne({
      where: { branch_id: branchId, business_date: date },
      include: [{ model: Branch, as: 'branch' }]
    });

    if (!report) {
      throw new NotFoundError('Daily report not found');
    }

    // Get sessions for this day
    const sessions = await RegisterSession.findAll({
      where: { branch_id: branchId, business_date: date },
      include: [
        { model: CashRegister, as: 'register' },
        { model: User, as: 'opener', attributes: ['first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['first_name', 'last_name'] }
      ],
      order: [['opened_at', 'ASC']]
    });

    return success(res, {
      ...report.toJSON(),
      sessions
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Finalize daily report
 * POST /api/v1/registers/daily-reports/:branchId/:date/finalize
 */
exports.finalizeDailyReport = async (req, res, next) => {
  try {
    const { branchId, date } = req.params;

    const report = await DailyReport.findOne({
      where: { branch_id: branchId, business_date: date }
    });

    if (!report) {
      throw new NotFoundError('Daily report not found');
    }

    // Check all sessions are closed
    const openSessions = await RegisterSession.count({
      where: { branch_id: branchId, business_date: date, status: 'OPEN' }
    });

    if (openSessions > 0) {
      throw new BusinessError('Cannot finalize report with open sessions', 'E401');
    }

    await report.update({
      is_finalized: true,
      finalized_at: new Date(),
      finalized_by: req.user.id
    });

    return success(res, report);
  } catch (error) {
    next(error);
  }
};
