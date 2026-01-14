const { Op } = require('sequelize');
const {
  Sale, SaleItem, SalePayment, RegisterSession, DailyReport, Branch, User, Product,
  Category, Customer, PaymentMethod, BranchStock, sequelize
} = require('../database/models');
const { success } = require('../utils/apiResponse');
const { NotFoundError } = require('../middleware/errorHandler');

// Daily Report
exports.getDailyReport = async (req, res, next) => {
  try {
    const { branch_id, date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const dateString = targetDate.toISOString().split('T')[0];

    // Try to get existing report
    let report = await DailyReport.findOne({
      where: { branch_id, report_date: dateString },
      include: [{ model: Branch, as: 'branch', attributes: ['name', 'code'] }]
    });

    if (!report) {
      // Generate report on the fly
      report = await exports.generateDailyReportData(branch_id, targetDate);
    }

    return success(res, report);
  } catch (error) {
    next(error);
  }
};

exports.generateDailyReportData = async (branchId, date) => {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const dateString = date.toISOString().split('T')[0];

  // Get branch info with closing times
  const branch = await Branch.findByPk(branchId, {
    attributes: ['id', 'name', 'code', 'midday_closing_time', 'evening_closing_time', 'has_shift_change']
  });

  // Get all sessions for this day
  const sessions = await RegisterSession.findAll({
    where: {
      branch_id: branchId,
      business_date: dateString
    },
    include: [
      { model: User, as: 'opener', attributes: ['first_name', 'last_name'] },
      { model: User, as: 'closer', attributes: ['first_name', 'last_name'] }
    ],
    order: [['shift_type', 'ASC'], ['opened_at', 'ASC']]
  });

  // Get sales for each session with payment breakdown
  const shiftsData = await Promise.all(sessions.map(async (session) => {
    const sessionSales = await Sale.findAll({
      where: {
        session_id: session.id,
        status: 'COMPLETED'
      },
      include: [{
        model: SalePayment,
        as: 'payments',
        include: [{ model: PaymentMethod, as: 'payment_method', attributes: ['code', 'name'] }]
      }]
    });

    // Calculate payment breakdown
    const paymentTotals = {
      cash: 0,
      card: 0,
      qr: 0,
      transfer: 0
    };

    sessionSales.forEach(sale => {
      sale.payments?.forEach(payment => {
        const amount = parseFloat(payment.amount);
        const code = payment.payment_method?.code?.toUpperCase();
        if (code === 'CASH') paymentTotals.cash += amount;
        else if (code === 'DEBIT' || code === 'CREDIT') paymentTotals.card += amount;
        else if (code === 'QR') paymentTotals.qr += amount;
        else if (code === 'TRANSFER') paymentTotals.transfer += amount;
      });
    });

    const totalRevenue = sessionSales.reduce((sum, sale) => sum + parseFloat(sale.total_amount), 0);
    const voidedSales = await Sale.count({
      where: { session_id: session.id, status: 'VOIDED' }
    });

    return {
      shift_type: session.shift_type,
      session_id: session.id,
      opened_at: session.opened_at,
      closed_at: session.closed_at,
      opened_by: session.opener ? `${session.opener.first_name} ${session.opener.last_name}` : null,
      closed_by: session.closer ? `${session.closer.first_name} ${session.closer.last_name}` : null,
      status: session.status,
      sales_count: sessionSales.length,
      total_revenue: totalRevenue,
      expected_cash: paymentTotals.cash,
      expected_card: paymentTotals.card,
      expected_qr: paymentTotals.qr,
      expected_transfer: paymentTotals.transfer,
      declared_cash: session.declared_cash ? parseFloat(session.declared_cash) : null,
      declared_card: session.declared_card ? parseFloat(session.declared_card) : null,
      declared_qr: session.declared_qr ? parseFloat(session.declared_qr) : null,
      declared_transfer: session.declared_transfer ? parseFloat(session.declared_transfer) : null,
      discrepancy_cash: session.discrepancy_cash ? parseFloat(session.discrepancy_cash) : null,
      discrepancy_card: session.discrepancy_card ? parseFloat(session.discrepancy_card) : null,
      discrepancy_qr: session.discrepancy_qr ? parseFloat(session.discrepancy_qr) : null,
      discrepancy_transfer: session.discrepancy_transfer ? parseFloat(session.discrepancy_transfer) : null,
      voided_sales_count: voidedSales
    };
  }));

  const saleWhere = {
    branch_id: branchId,
    status: 'COMPLETED',
    created_at: { [Op.between]: [startOfDay, endOfDay] }
  };

  // Sales totals (for backward compatibility)
  const salesData = await Sale.findOne({
    where: saleWhere,
    attributes: [
      [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
      [sequelize.fn('SUM', sequelize.col('tax_amount')), 'total_tax'],
      [sequelize.fn('SUM', sequelize.col('discount_amount')), 'total_discounts'],
      [sequelize.fn('AVG', sequelize.col('total_amount')), 'average_ticket']
    ]
  });

  // Voided sales
  const voidedData = await Sale.findOne({
    where: {
      branch_id: branchId,
      status: 'VOIDED',
      created_at: { [Op.between]: [startOfDay, endOfDay] }
    },
    attributes: [
      [sequelize.fn('COUNT', sequelize.col('id')), 'voided_count'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'voided_amount']
    ]
  });

  // Payment methods breakdown
  const paymentBreakdown = await SalePayment.findAll({
    attributes: [
      'payment_method_id',
      [sequelize.fn('SUM', sequelize.col('amount')), 'total']
    ],
    include: [
      {
        model: Sale,
        as: 'sale',
        where: saleWhere,
        attributes: []
      },
      {
        model: PaymentMethod,
        as: 'payment_method',
        attributes: ['name', 'code']
      }
    ],
    where: { status: 'APPROVED' },
    group: ['payment_method_id', 'payment_method.id', 'payment_method.name', 'payment_method.code']
  });

  // Session summary
  const sessionSummary = await RegisterSession.findAll({
    where: {
      branch_id: branchId,
      opened_at: { [Op.between]: [startOfDay, endOfDay] }
    },
    attributes: [
      [sequelize.fn('COUNT', sequelize.col('id')), 'total_sessions'],
      [sequelize.fn('SUM', sequelize.col('opening_amount')), 'total_opening'],
      [sequelize.fn('SUM', sequelize.col('closing_amount')), 'total_closing'],
      [sequelize.fn('SUM', sequelize.col('discrepancy_cash')), 'total_discrepancy']
    ]
  });

  // Top products
  const topProducts = await SaleItem.findAll({
    attributes: [
      'product_id',
      [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
      [sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'total_revenue']
    ],
    include: [
      {
        model: Sale,
        as: 'sale',
        where: saleWhere,
        attributes: []
      },
      {
        model: Product,
        as: 'product',
        attributes: ['name', 'sku']
      }
    ],
    group: ['product_id', 'product.id', 'product.name', 'product.sku'],
    order: [[sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'DESC']],
    limit: 10
  });

  // Hourly breakdown
  const hourlyData = await sequelize.query(`
    SELECT
      EXTRACT(HOUR FROM created_at) as hour,
      COUNT(*) as sales_count,
      SUM(total_amount) as revenue
    FROM sales
    WHERE branch_id = :branchId
      AND status = 'COMPLETED'
      AND created_at BETWEEN :startOfDay AND :endOfDay
    GROUP BY EXTRACT(HOUR FROM created_at)
    ORDER BY hour
  `, {
    replacements: { branchId, startOfDay, endOfDay },
    type: sequelize.QueryTypes.SELECT
  });

  // Calculate daily totals from shifts
  const dailyTotals = {
    total_cash: shiftsData.reduce((sum, s) => sum + (s.expected_cash || 0), 0),
    total_card: shiftsData.reduce((sum, s) => sum + (s.expected_card || 0), 0),
    total_qr: shiftsData.reduce((sum, s) => sum + (s.expected_qr || 0), 0),
    total_transfer: shiftsData.reduce((sum, s) => sum + (s.expected_transfer || 0), 0),
    total_discrepancy_cash: shiftsData.reduce((sum, s) => sum + (s.discrepancy_cash || 0), 0),
    total_discrepancy_card: shiftsData.reduce((sum, s) => sum + (s.discrepancy_card || 0), 0),
    total_discrepancy_qr: shiftsData.reduce((sum, s) => sum + (s.discrepancy_qr || 0), 0),
    total_discrepancy_transfer: shiftsData.reduce((sum, s) => sum + (s.discrepancy_transfer || 0), 0)
  };

  return {
    report_date: date.toISOString().split('T')[0],
    branch_id: branchId,
    branch: branch ? {
      name: branch.name,
      code: branch.code,
      midday_closing_time: branch.midday_closing_time,
      evening_closing_time: branch.evening_closing_time,
      has_shift_change: branch.has_shift_change
    } : null,
    shifts: shiftsData,
    daily_totals: dailyTotals,
    sales: {
      total_count: parseInt(salesData?.toJSON().total_sales) || 0,
      total_revenue: parseFloat(salesData?.toJSON().total_revenue) || 0,
      total_tax: parseFloat(salesData?.toJSON().total_tax) || 0,
      total_discounts: parseFloat(salesData?.toJSON().total_discounts) || 0,
      average_ticket: parseFloat(salesData?.toJSON().average_ticket) || 0,
      voided_count: parseInt(voidedData?.toJSON().voided_count) || 0,
      voided_amount: parseFloat(voidedData?.toJSON().voided_amount) || 0
    },
    payments: paymentBreakdown.map((p) => ({
      method: p.payment_method?.name,
      code: p.payment_method?.code,
      total: parseFloat(p.toJSON().total)
    })),
    sessions: sessionSummary[0]?.toJSON() || {},
    top_products: topProducts.map((p) => ({
      product: p.product?.name,
      sku: p.product?.sku,
      quantity: parseFloat(p.toJSON().total_quantity),
      revenue: parseFloat(p.toJSON().total_revenue)
    })),
    hourly: hourlyData
  };
};

// Owner Dashboard
exports.getOwnerDashboard = async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const endDate = end_date ? new Date(end_date) : new Date();
    const startDate = start_date ? new Date(start_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all branches for the owner
    const branches = await Branch.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'code']
    });

    // Overall metrics
    const overallSales = await Sale.findOne({
      where: {
        status: 'COMPLETED',
        created_at: { [Op.between]: [startDate, endDate] }
      },
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
        [sequelize.fn('AVG', sequelize.col('total_amount')), 'average_ticket']
      ]
    });

    // Sales by branch
    const salesByBranch = await Sale.findAll({
      where: {
        status: 'COMPLETED',
        created_at: { [Op.between]: [startDate, endDate] }
      },
      attributes: [
        'branch_id',
        [sequelize.fn('COUNT', sequelize.col('Sale.id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('Sale.total_amount')), 'total_revenue']
      ],
      include: [{ model: Branch, as: 'branch', attributes: ['name', 'code'] }],
      group: ['branch_id', 'branch.id', 'branch.name', 'branch.code']
    });

    // Daily trend
    const dailyTrend = await sequelize.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as sales_count,
        SUM(total_amount) as revenue
      FROM sales
      WHERE status = 'COMPLETED'
        AND created_at BETWEEN :startDate AND :endDate
      GROUP BY DATE(created_at)
      ORDER BY date
    `, {
      replacements: { startDate, endDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Cash discrepancies
    const discrepancies = await RegisterSession.findAll({
      where: {
        closed_at: { [Op.between]: [startDate, endDate] },
        discrepancy_cash: { [Op.ne]: 0 }
      },
      attributes: [
        'branch_id',
        [sequelize.fn('COUNT', sequelize.col('RegisterSession.id')), 'count'],
        [sequelize.fn('SUM', sequelize.col('RegisterSession.discrepancy_cash')), 'total_discrepancy']
      ],
      include: [{ model: Branch, as: 'branch', attributes: ['name', 'code'] }],
      group: ['branch_id', 'branch.id', 'branch.name', 'branch.code']
    });

    // Shrinkage summary from stock_movements
    const shrinkageMovements = await sequelize.query(`
      SELECT
        COUNT(*) as total_records,
        SUM(ABS(sm.quantity) * p.cost_price) as total_cost_loss
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      WHERE sm.movement_type = 'SHRINKAGE'
        AND sm.created_at BETWEEN :startDate AND :endDate
    `, {
      replacements: { startDate, endDate },
      type: sequelize.QueryTypes.SELECT
    });

    const shrinkage = {
      total_records: parseInt(shrinkageMovements[0]?.total_records) || 0,
      total_cost_loss: parseFloat(shrinkageMovements[0]?.total_cost_loss) || 0
    };

    // Top selling products overall
    const topProducts = await SaleItem.findAll({
      attributes: [
        'product_id',
        [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
        [sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'total_revenue']
      ],
      include: [
        {
          model: Sale,
          as: 'sale',
          where: {
            status: 'COMPLETED',
            created_at: { [Op.between]: [startDate, endDate] }
          },
          attributes: []
        },
        {
          model: Product,
          as: 'product',
          attributes: ['name', 'sku']
        }
      ],
      group: ['product_id', 'product.id', 'product.name', 'product.sku'],
      order: [[sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'DESC']],
      limit: 10
    });

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      branches: branches.length,
      overall: {
        total_sales: parseInt(overallSales?.toJSON().total_sales) || 0,
        total_revenue: parseFloat(overallSales?.toJSON().total_revenue) || 0,
        average_ticket: parseFloat(overallSales?.toJSON().average_ticket) || 0
      },
      by_branch: salesByBranch,
      daily_trend: dailyTrend,
      discrepancies,
      shrinkage,
      top_products: topProducts
    });
  } catch (error) {
    next(error);
  }
};

// Consolidated Daily Report Across All Branches
exports.getConsolidatedDailyReport = async (req, res, next) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const dateString = targetDate.toISOString().split('T')[0];

    // Get all active branches
    const branches = await Branch.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'code'],
      order: [['code', 'ASC']]
    });

    // Get all sessions for this date across all branches
    const allSessions = await RegisterSession.findAll({
      where: {
        business_date: dateString,
        status: { [Op.in]: ['CLOSED', 'REOPENED'] }
      },
      include: [
        { model: Branch, as: 'branch', attributes: ['name', 'code'] },
        { model: User, as: 'opener', attributes: ['first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['first_name', 'last_name'] }
      ],
      order: [['branch_id', 'ASC'], ['shift_type', 'ASC']]
    });

    // Build per-branch reports
    const branchReports = await Promise.all(branches.map(async (branch) => {
      const branchSessions = allSessions.filter(s => s.branch_id === branch.id);

      if (branchSessions.length === 0) {
        return {
          branch_id: branch.id,
          branch_name: branch.name,
          branch_code: branch.code,
          total_cash: 0,
          total_card: 0,
          total_qr: 0,
          total_transfer: 0,
          discrepancy_cash: 0,
          discrepancy_card: 0,
          discrepancy_qr: 0,
          discrepancy_transfer: 0,
          sales_count: 0,
          total_revenue: 0,
          sessions: []
        };
      }

      // Aggregate totals from all sessions for this branch
      const totals = branchSessions.reduce((acc, session) => {
        return {
          cash: acc.cash + parseFloat(session.expected_cash || 0),
          card: acc.card + parseFloat(session.expected_card || 0),
          qr: acc.qr + parseFloat(session.expected_qr || 0),
          transfer: acc.transfer + parseFloat(session.expected_transfer || 0),
          discrepancy_cash: acc.discrepancy_cash + parseFloat(session.discrepancy_cash || 0),
          discrepancy_card: acc.discrepancy_card + parseFloat(session.discrepancy_card || 0),
          discrepancy_qr: acc.discrepancy_qr + parseFloat(session.discrepancy_qr || 0),
          discrepancy_transfer: acc.discrepancy_transfer + parseFloat(session.discrepancy_transfer || 0)
        };
      }, {
        cash: 0, card: 0, qr: 0, transfer: 0,
        discrepancy_cash: 0, discrepancy_card: 0, discrepancy_qr: 0, discrepancy_transfer: 0
      });

      // Get sales count and revenue for this branch on this date
      const salesCount = await Sale.count({
        where: {
          branch_id: branch.id,
          business_date: dateString,
          status: 'COMPLETED'
        }
      });

      const totalRevenue = await Sale.sum('total_amount', {
        where: {
          branch_id: branch.id,
          business_date: dateString,
          status: 'COMPLETED'
        }
      }) || 0;

      return {
        branch_id: branch.id,
        branch_name: branch.name,
        branch_code: branch.code,
        total_cash: totals.cash,
        total_card: totals.card,
        total_qr: totals.qr,
        total_transfer: totals.transfer,
        discrepancy_cash: totals.discrepancy_cash,
        discrepancy_card: totals.discrepancy_card,
        discrepancy_qr: totals.discrepancy_qr,
        discrepancy_transfer: totals.discrepancy_transfer,
        sales_count: salesCount,
        total_revenue: parseFloat(totalRevenue),
        sessions: branchSessions.map(s => ({
          shift_type: s.shift_type,
          status: s.status,
          opened_by: s.opener ? `${s.opener.first_name} ${s.opener.last_name}` : null,
          closed_by: s.closer ? `${s.closer.first_name} ${s.closer.last_name}` : null
        }))
      };
    }));

    // Calculate consolidated totals across ALL branches
    const consolidatedTotals = branchReports.reduce((acc, branch) => {
      return {
        total_cash: acc.total_cash + branch.total_cash,
        total_card: acc.total_card + branch.total_card,
        total_qr: acc.total_qr + branch.total_qr,
        total_transfer: acc.total_transfer + branch.total_transfer,
        total_discrepancy_cash: acc.total_discrepancy_cash + branch.discrepancy_cash,
        total_discrepancy_card: acc.total_discrepancy_card + branch.discrepancy_card,
        total_discrepancy_qr: acc.total_discrepancy_qr + branch.discrepancy_qr,
        total_discrepancy_transfer: acc.total_discrepancy_transfer + branch.discrepancy_transfer,
        total_sales: acc.total_sales + branch.sales_count,
        total_revenue: acc.total_revenue + branch.total_revenue
      };
    }, {
      total_cash: 0,
      total_card: 0,
      total_qr: 0,
      total_transfer: 0,
      total_discrepancy_cash: 0,
      total_discrepancy_card: 0,
      total_discrepancy_qr: 0,
      total_discrepancy_transfer: 0,
      total_sales: 0,
      total_revenue: 0
    });

    return success(res, {
      date: dateString,
      branches: branchReports,
      consolidated: consolidatedTotals
    });
  } catch (error) {
    next(error);
  }
};

// Live Branch Shift Status (Today's shifts for all branches)
exports.getLiveBranchShiftStatus = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get all active branches with their shift configuration
    const branches = await Branch.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'code', 'midday_closing_time', 'evening_closing_time', 'has_shift_change'],
      order: [['code', 'ASC']]
    });

    // Get today's sessions for all branches
    const branchesWithSessions = await Promise.all(branches.map(async (branch) => {
      const sessions = await RegisterSession.findAll({
        where: {
          branch_id: branch.id,
          business_date: today
        },
        include: [
          {
            model: User,
            as: 'opener',
            attributes: ['first_name', 'last_name']
          },
          {
            model: User,
            as: 'closer',
            attributes: ['first_name', 'last_name']
          }
        ],
        order: [['shift_type', 'ASC']]
      });

      // Get sales count for each session
      const sessionsWithSales = await Promise.all(sessions.map(async (session) => {
        const salesCount = await Sale.count({
          where: {
            session_id: session.id,
            status: 'COMPLETED'
          }
        });

        const totalRevenue = await Sale.sum('total_amount', {
          where: {
            session_id: session.id,
            status: 'COMPLETED'
          }
        }) || 0;

        return {
          session_id: session.id,
          shift_type: session.shift_type,
          status: session.status,
          opened_at: session.opened_at,
          closed_at: session.closed_at,
          opened_by: session.opener ? `${session.opener.first_name} ${session.opener.last_name}` : null,
          closed_by: session.closer ? `${session.closer.first_name} ${session.closer.last_name}` : null,
          sales_count: salesCount,
          total_revenue: parseFloat(totalRevenue)
        };
      }));

      return {
        branch_id: branch.id,
        branch_name: branch.name,
        branch_code: branch.code,
        midday_closing_time: branch.midday_closing_time,
        evening_closing_time: branch.evening_closing_time,
        has_shift_change: branch.has_shift_change,
        sessions: sessionsWithSales
      };
    }));

    return success(res, {
      date: today,
      branches: branchesWithSessions
    });
  } catch (error) {
    next(error);
  }
};

// Sales Report
exports.getSalesReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date, group_by = 'day' } = req.query;

    const where = { status: 'COMPLETED' };
    if (branch_id) where.branch_id = branch_id;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    where.created_at = { [Op.between]: [startDate, endDate] };

    let groupByClause;
    let selectDate;
    switch (group_by) {
      case 'hour':
        groupByClause = "DATE_TRUNC('hour', created_at)";
        selectDate = "DATE_TRUNC('hour', created_at)";
        break;
      case 'week':
        groupByClause = "DATE_TRUNC('week', created_at)";
        selectDate = "DATE_TRUNC('week', created_at)";
        break;
      case 'month':
        groupByClause = "DATE_TRUNC('month', created_at)";
        selectDate = "DATE_TRUNC('month', created_at)";
        break;
      default:
        groupByClause = 'DATE(created_at)';
        selectDate = 'DATE(created_at)';
    }

    const salesData = await sequelize.query(`
      SELECT
        ${selectDate} as period,
        COUNT(*) as sales_count,
        SUM(total_amount) as revenue,
        SUM(tax_amount) as tax,
        SUM(discount_amount) as discounts,
        AVG(total_amount) as avg_ticket
      FROM sales
      WHERE status = 'COMPLETED'
        AND ${branch_id ? 'branch_id = :branchId AND' : ''}
        created_at BETWEEN :startDate AND :endDate
      GROUP BY ${groupByClause}
      ORDER BY period
    `, {
      replacements: { branchId: branch_id, startDate, endDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Totals
    const totals = await Sale.findOne({
      where,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
        [sequelize.fn('SUM', sequelize.col('tax_amount')), 'total_tax'],
        [sequelize.fn('SUM', sequelize.col('discount_amount')), 'total_discounts'],
        [sequelize.fn('AVG', sequelize.col('total_amount')), 'average_ticket']
      ]
    });

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      group_by,
      data: salesData,
      totals: totals?.toJSON()
    });
  } catch (error) {
    next(error);
  }
};

// Product Performance Report
exports.getProductReport = async (req, res, next) => {
  try {
    const { branch_id, category_id, from_date, to_date, limit = 50 } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const saleWhere = {
      status: 'COMPLETED',
      created_at: { [Op.between]: [startDate, endDate] }
    };
    if (branch_id) saleWhere.branch_id = branch_id;

    const productWhere = {};
    if (category_id) productWhere.category_id = category_id;

    const products = await SaleItem.findAll({
      attributes: [
        'product_id',
        [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
        [sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'total_revenue'],
        [sequelize.fn('COUNT', sequelize.literal('DISTINCT sale_id')), 'transaction_count'],
        [sequelize.fn('AVG', sequelize.col('unit_price')), 'avg_price']
      ],
      include: [
        {
          model: Sale,
          as: 'sale',
          where: saleWhere,
          attributes: []
        },
        {
          model: Product,
          as: 'product',
          where: Object.keys(productWhere).length ? productWhere : undefined,
          attributes: ['name', 'sku', 'cost_price', 'selling_price'],
          include: [{ model: Category, as: 'category', attributes: ['name'] }]
        }
      ],
      group: ['product_id', 'product.id', 'product.name', 'product.sku', 'product.cost_price', 'product.selling_price', 'product.category.id', 'product.category.name'],
      order: [[sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate margins
    const productsWithMargin = products.map((p) => {
      const data = p.toJSON();
      const costPrice = parseFloat(p.product?.cost_price) || 0;
      const avgPrice = parseFloat(data.avg_price) || 0;
      const margin = avgPrice > 0 ? ((avgPrice - costPrice) / avgPrice) * 100 : 0;

      return {
        product_id: data.product_id,
        name: p.product?.name,
        sku: p.product?.sku,
        category: p.product?.category?.name,
        total_quantity: parseFloat(data.total_quantity),
        total_revenue: parseFloat(data.total_revenue),
        transaction_count: parseInt(data.transaction_count),
        avg_price: avgPrice,
        margin_percent: margin.toFixed(2)
      };
    });

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      products: productsWithMargin
    });
  } catch (error) {
    next(error);
  }
};

// Cashier Performance Report
exports.getCashierReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const saleWhere = {
      status: 'COMPLETED',
      created_at: { [Op.between]: [startDate, endDate] }
    };
    if (branch_id) saleWhere.branch_id = branch_id;

    // Sale model uses created_by with alias 'creator' (not cashier_id)
    const cashierPerformance = await Sale.findAll({
      where: saleWhere,
      attributes: [
        'created_by',
        [sequelize.fn('COUNT', sequelize.col('Sale.id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
        [sequelize.fn('AVG', sequelize.col('total_amount')), 'average_ticket']
      ],
      include: [{
        model: User,
        as: 'creator',
        attributes: ['first_name', 'last_name']
      }],
      group: ['created_by', 'creator.id', 'creator.first_name', 'creator.last_name'],
      order: [[sequelize.fn('SUM', sequelize.col('total_amount')), 'DESC']]
    });

    // Get session data for each cashier
    const sessionWhere = {
      closed_at: { [Op.between]: [startDate, endDate] }
    };
    if (branch_id) sessionWhere.branch_id = branch_id;

    // RegisterSession uses opened_by (not cashier_id)
    const sessionData = await RegisterSession.findAll({
      where: sessionWhere,
      attributes: [
        'opened_by',
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sessions'],
        [sequelize.fn('SUM', sequelize.col('discrepancy_cash')), 'total_discrepancy'],
        [sequelize.fn('AVG', sequelize.literal("EXTRACT(EPOCH FROM (closed_at - opened_at)) / 3600")), 'avg_session_hours']
      ],
      group: ['opened_by']
    });

    // Combine data
    const combined = cashierPerformance.map((c) => {
      // Match session data by created_by (sale creator) to opened_by (session owner)
      const session = sessionData.find((s) => s.opened_by === c.created_by);
      return {
        cashier_id: c.created_by,
        name: `${c.creator?.first_name || ''} ${c.creator?.last_name || ''}`.trim(),
        total_sales: parseInt(c.toJSON().total_sales),
        total_revenue: parseFloat(c.toJSON().total_revenue),
        average_ticket: parseFloat(c.toJSON().average_ticket),
        total_sessions: parseInt(session?.toJSON().total_sessions) || 0,
        total_discrepancy: parseFloat(session?.toJSON().total_discrepancy) || 0,
        avg_session_hours: parseFloat(session?.toJSON().avg_session_hours)?.toFixed(2) || 0
      };
    });

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      cashiers: combined
    });
  } catch (error) {
    next(error);
  }
};

// Inventory Report
exports.getInventoryReport = async (req, res, next) => {
  try {
    const { branch_id, category_id, low_stock_only } = req.query;

    const where = {};
    if (branch_id) where.branch_id = branch_id;

    const productWhere = { is_active: true };
    if (category_id) productWhere.category_id = category_id;

    if (low_stock_only === 'true') {
      where[Op.and] = [
        sequelize.where(
          sequelize.col('quantity'),
          Op.lte,
          sequelize.col('product.minimum_stock')
        )
      ];
    }

    const stocks = await BranchStock.findAll({
      where,
      include: [
        {
          model: Product,
          as: 'product',
          where: productWhere,
          attributes: ['name', 'sku', 'cost_price', 'selling_price', 'minimum_stock'],
          include: [{ model: Category, as: 'category', attributes: ['name'] }]
        },
        { model: Branch, as: 'branch', attributes: ['name', 'code'] }
      ],
      order: [['quantity', 'ASC']]
    });

    // Calculate inventory value
    const inventory = stocks.map((s) => {
      const costPrice = parseFloat(s.product?.cost_price) || 0;
      const sellingPrice = parseFloat(s.product?.selling_price) || 0;
      const quantity = parseFloat(s.quantity);
      const minStock = parseFloat(s.product?.minimum_stock) || 0;

      return {
        branch: s.branch?.name,
        branch_code: s.branch?.code,
        product: s.product?.name,
        sku: s.product?.sku,
        category: s.product?.category?.name,
        quantity,
        min_stock: minStock,
        max_stock: 0,
        cost_value: quantity * costPrice,
        retail_value: quantity * sellingPrice,
        is_low: quantity <= minStock
      };
    });

    // Totals
    const totalCostValue = inventory.reduce((sum, i) => sum + i.cost_value, 0);
    const totalRetailValue = inventory.reduce((sum, i) => sum + i.retail_value, 0);
    const lowStockCount = inventory.filter((i) => i.is_low).length;

    return success(res, {
      inventory,
      summary: {
        total_items: inventory.length,
        total_cost_value: totalCostValue,
        total_retail_value: totalRetailValue,
        low_stock_count: lowStockCount
      }
    });
  } catch (error) {
    next(error);
  }
};
// Sales by Category Report
exports.getCategoryReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const saleWhere = {
      status: 'COMPLETED',
      created_at: { [Op.between]: [startDate, endDate] }
    };
    if (branch_id) saleWhere.branch_id = branch_id;

    // Sales by category
    const categoryData = await SaleItem.findAll({
      attributes: [
        [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
        [sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'total_revenue'],
        [sequelize.fn('COUNT', sequelize.literal('DISTINCT sale_id')), 'transaction_count'],
        [sequelize.fn('AVG', sequelize.col('SaleItem.line_total')), 'avg_sale']
      ],
      include: [
        {
          model: Sale,
          as: 'sale',
          where: saleWhere,
          attributes: []
        },
        {
          model: Product,
          as: 'product',
          attributes: ['category_id'],
          include: [{
            model: Category,
            as: 'category',
            attributes: ['id', 'name', 'description']
          }]
        }
      ],
      group: ['product.category.id', 'product.category.name', 'product.category.description'],
      order: [[sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'DESC']]
    });

    // Calculate profit margin by category
    const categoriesWithMargin = await Promise.all(categoryData.map(async (cat) => {
      const categoryId = cat.product?.category?.id;

      if (!categoryId) {
        return {
          category_id: null,
          category_name: 'Sin Categoría',
          total_quantity: parseFloat(cat.toJSON().total_quantity),
          total_revenue: parseFloat(cat.toJSON().total_revenue),
          transaction_count: parseInt(cat.toJSON().transaction_count),
          avg_sale: parseFloat(cat.toJSON().avg_sale),
          total_cost: 0,
          margin_percent: 0
        };
      }

      // Calculate total cost for products in this category
      const costData = await sequelize.query(`
        SELECT
          SUM(si.quantity * p.cost_price) as total_cost,
          SUM(si.line_total) as total_revenue
        FROM sale_items si
        INNER JOIN sales s ON si.sale_id = s.id
        INNER JOIN products p ON si.product_id = p.id
        WHERE s.status = 'COMPLETED'
          AND s.created_at BETWEEN :startDate AND :endDate
          ${branch_id ? 'AND s.branch_id = :branchId' : ''}
          AND p.category_id = :categoryId
      `, {
        replacements: { startDate, endDate, branchId: branch_id, categoryId },
        type: sequelize.QueryTypes.SELECT
      });

      const totalCost = parseFloat(costData[0]?.total_cost) || 0;
      const totalRevenue = parseFloat(costData[0]?.total_revenue) || 0;
      const marginPercent = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;

      return {
        category_id: categoryId,
        category_name: cat.product?.category?.name,
        category_description: cat.product?.category?.description,
        total_quantity: parseFloat(cat.toJSON().total_quantity),
        total_revenue: totalRevenue,
        total_cost: totalCost,
        transaction_count: parseInt(cat.toJSON().transaction_count),
        avg_sale: parseFloat(cat.toJSON().avg_sale),
        margin_percent: marginPercent.toFixed(2)
      };
    }));

    // Overall totals
    const totalRevenue = categoriesWithMargin.reduce((sum, c) => sum + c.total_revenue, 0);
    const totalCost = categoriesWithMargin.reduce((sum, c) => sum + c.total_cost, 0);
    const totalQuantity = categoriesWithMargin.reduce((sum, c) => sum + c.total_quantity, 0);

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      categories: categoriesWithMargin,
      totals: {
        total_revenue: totalRevenue,
        total_cost: totalCost,
        total_quantity: totalQuantity,
        overall_margin: totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    next(error);
  }
};

// Cash Discrepancy Report
exports.getDiscrepancyReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const sessionWhere = {
      closed_at: { [Op.between]: [startDate, endDate] },
      status: { [Op.in]: ['CLOSED', 'REOPENED'] }
    };
    if (branch_id) sessionWhere.branch_id = branch_id;

    // Get all sessions with discrepancies
    const sessions = await RegisterSession.findAll({
      where: sessionWhere,
      include: [
        {
          model: Branch,
          as: 'branch',
          attributes: ['name', 'code']
        },
        {
          model: User,
          as: 'opener',
          attributes: ['first_name', 'last_name']
        },
        {
          model: User,
          as: 'closer',
          attributes: ['first_name', 'last_name']
        }
      ],
      order: [['closed_at', 'DESC']]
    });

    // Filter and format sessions with any discrepancy
    const discrepancies = sessions
      .filter(s =>
        parseFloat(s.discrepancy_cash || 0) !== 0 ||
        parseFloat(s.discrepancy_card || 0) !== 0 ||
        parseFloat(s.discrepancy_qr || 0) !== 0 ||
        parseFloat(s.discrepancy_transfer || 0) !== 0
      )
      .map(s => ({
        session_id: s.id,
        branch: s.branch?.name,
        branch_code: s.branch?.code,
        business_date: s.business_date,
        shift_type: s.shift_type,
        opened_by: s.opener ? `${s.opener.first_name} ${s.opener.last_name}` : null,
        closed_by: s.closer ? `${s.closer.first_name} ${s.closer.last_name}` : null,
        opened_at: s.opened_at,
        closed_at: s.closed_at,
        expected_cash: parseFloat(s.expected_cash || 0),
        declared_cash: parseFloat(s.declared_cash || 0),
        discrepancy_cash: parseFloat(s.discrepancy_cash || 0),
        expected_card: parseFloat(s.expected_card || 0),
        declared_card: parseFloat(s.declared_card || 0),
        discrepancy_card: parseFloat(s.discrepancy_card || 0),
        expected_qr: parseFloat(s.expected_qr || 0),
        declared_qr: parseFloat(s.declared_qr || 0),
        discrepancy_qr: parseFloat(s.discrepancy_qr || 0),
        expected_transfer: parseFloat(s.expected_transfer || 0),
        declared_transfer: parseFloat(s.declared_transfer || 0),
        discrepancy_transfer: parseFloat(s.discrepancy_transfer || 0),
        total_discrepancy: parseFloat(s.discrepancy_cash || 0) +
                          parseFloat(s.discrepancy_card || 0) +
                          parseFloat(s.discrepancy_qr || 0) +
                          parseFloat(s.discrepancy_transfer || 0)
      }));

    // Summary statistics
    const summary = {
      total_sessions_with_discrepancy: discrepancies.length,
      total_discrepancy_cash: discrepancies.reduce((sum, d) => sum + d.discrepancy_cash, 0),
      total_discrepancy_card: discrepancies.reduce((sum, d) => sum + d.discrepancy_card, 0),
      total_discrepancy_qr: discrepancies.reduce((sum, d) => sum + d.discrepancy_qr, 0),
      total_discrepancy_transfer: discrepancies.reduce((sum, d) => sum + d.discrepancy_transfer, 0),
      total_discrepancy_overall: discrepancies.reduce((sum, d) => sum + d.total_discrepancy, 0),
      avg_discrepancy: discrepancies.length > 0
        ? discrepancies.reduce((sum, d) => sum + d.total_discrepancy, 0) / discrepancies.length
        : 0
    };

    // By branch breakdown (if viewing all branches)
    const byBranch = {};
    discrepancies.forEach(d => {
      if (!byBranch[d.branch_code]) {
        byBranch[d.branch_code] = {
          branch: d.branch,
          count: 0,
          total_discrepancy: 0
        };
      }
      byBranch[d.branch_code].count++;
      byBranch[d.branch_code].total_discrepancy += d.total_discrepancy;
    });

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      discrepancies,
      summary,
      by_branch: Object.values(byBranch)
    });
  } catch (error) {
    next(error);
  }
};

// Payment Method Breakdown Report
exports.getPaymentMethodReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const saleWhere = {
      status: 'COMPLETED',
      created_at: { [Op.between]: [startDate, endDate] }
    };
    if (branch_id) saleWhere.branch_id = branch_id;

    // Payment breakdown by method
    const paymentData = await SalePayment.findAll({
      attributes: [
        'payment_method_id',
        [sequelize.fn('COUNT', sequelize.col('SalePayment.id')), 'transaction_count'],
        [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
        [sequelize.fn('AVG', sequelize.col('amount')), 'avg_amount'],
        [sequelize.fn('MIN', sequelize.col('amount')), 'min_amount'],
        [sequelize.fn('MAX', sequelize.col('amount')), 'max_amount']
      ],
      include: [
        {
          model: Sale,
          as: 'sale',
          where: saleWhere,
          attributes: []
        },
        {
          model: PaymentMethod,
          as: 'payment_method',
          attributes: ['id', 'name', 'code', 'type']
        }
      ],
      where: { status: 'APPROVED' },
      group: ['payment_method_id', 'payment_method.id', 'payment_method.name', 'payment_method.code', 'payment_method.type'],
      order: [[sequelize.fn('SUM', sequelize.col('amount')), 'DESC']]
    });

    const payments = paymentData.map(p => ({
      payment_method_id: p.payment_method?.id,
      payment_method: p.payment_method?.name,
      code: p.payment_method?.code,
      type: p.payment_method?.type,
      transaction_count: parseInt(p.toJSON().transaction_count),
      total_amount: parseFloat(p.toJSON().total_amount),
      avg_amount: parseFloat(p.toJSON().avg_amount),
      min_amount: parseFloat(p.toJSON().min_amount),
      max_amount: parseFloat(p.toJSON().max_amount)
    }));

    // Overall totals
    const totalAmount = payments.reduce((sum, p) => sum + p.total_amount, 0);
    const totalTransactions = payments.reduce((sum, p) => sum + p.transaction_count, 0);

    // Add percentage to each method
    const paymentsWithPercentage = payments.map(p => ({
      ...p,
      percentage: totalAmount > 0 ? ((p.total_amount / totalAmount) * 100).toFixed(2) : 0
    }));

    // Daily breakdown
    const dailyBreakdown = await sequelize.query(`
      SELECT
        DATE(s.created_at) as date,
        pm.name as payment_method,
        pm.code,
        COUNT(sp.id) as transaction_count,
        SUM(sp.amount) as total_amount
      FROM sale_payments sp
      INNER JOIN sales s ON sp.sale_id = s.id
      INNER JOIN payment_methods pm ON sp.payment_method_id = pm.id
      WHERE s.status = 'COMPLETED'
        AND s.created_at BETWEEN :startDate AND :endDate
        ${branch_id ? 'AND s.branch_id = :branchId' : ''}
        AND sp.status = 'APPROVED'
      GROUP BY DATE(s.created_at), pm.id, pm.name, pm.code
      ORDER BY date DESC, total_amount DESC
    `, {
      replacements: { startDate, endDate, branchId: branch_id },
      type: sequelize.QueryTypes.SELECT
    });

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      payments: paymentsWithPercentage,
      summary: {
        total_amount: totalAmount,
        total_transactions: totalTransactions,
        avg_transaction: totalTransactions > 0 ? totalAmount / totalTransactions : 0
      },
      daily_breakdown: dailyBreakdown
    });
  } catch (error) {
    next(error);
  }
};

// Shrinkage Report
exports.getShrinkageReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get shrinkage movements from stock_movements table
    const shrinkageQuery = `
      SELECT
        sm.id as movement_id,
        sm.created_at,
        sm.quantity,
        sm.reason,
        sm.notes,
        b.id as branch_id,
        b.name as branch_name,
        b.code as branch_code,
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.cost_price,
        p.selling_price,
        c.name as category_name,
        u.first_name || ' ' || u.last_name as created_by_name,
        (ABS(sm.quantity) * p.cost_price) as cost_loss,
        (ABS(sm.quantity) * p.selling_price) as retail_loss
      FROM stock_movements sm
      INNER JOIN products p ON sm.product_id = p.id
      INNER JOIN branches b ON sm.branch_id = b.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN users u ON sm.created_by = u.id
      WHERE sm.movement_type = 'SHRINKAGE'
        AND sm.created_at BETWEEN :startDate AND :endDate
        ${branch_id ? 'AND sm.branch_id = :branchId' : ''}
      ORDER BY sm.created_at DESC
    `;

    const shrinkageData = await sequelize.query(shrinkageQuery, {
      replacements: { startDate, endDate, branchId: branch_id },
      type: sequelize.QueryTypes.SELECT
    });

    // Summary statistics
    const totalCostLoss = shrinkageData.reduce((sum, s) => sum + parseFloat(s.cost_loss || 0), 0);
    const totalRetailLoss = shrinkageData.reduce((sum, s) => sum + parseFloat(s.retail_loss || 0), 0);
    const totalQuantity = shrinkageData.reduce((sum, s) => sum + Math.abs(parseFloat(s.quantity || 0)), 0);

    // By category breakdown
    const byCategory = {};
    shrinkageData.forEach(s => {
      const catName = s.category_name || 'Sin Categoría';
      if (!byCategory[catName]) {
        byCategory[catName] = {
          category: catName,
          count: 0,
          total_quantity: 0,
          cost_loss: 0,
          retail_loss: 0
        };
      }
      byCategory[catName].count++;
      byCategory[catName].total_quantity += Math.abs(parseFloat(s.quantity || 0));
      byCategory[catName].cost_loss += parseFloat(s.cost_loss || 0);
      byCategory[catName].retail_loss += parseFloat(s.retail_loss || 0);
    });

    // By branch breakdown (if viewing all branches)
    const byBranch = {};
    shrinkageData.forEach(s => {
      if (!byBranch[s.branch_code]) {
        byBranch[s.branch_code] = {
          branch: s.branch_name,
          branch_code: s.branch_code,
          count: 0,
          cost_loss: 0,
          retail_loss: 0
        };
      }
      byBranch[s.branch_code].count++;
      byBranch[s.branch_code].cost_loss += parseFloat(s.cost_loss || 0);
      byBranch[s.branch_code].retail_loss += parseFloat(s.retail_loss || 0);
    });

    // Top products by shrinkage
    const byProduct = {};
    shrinkageData.forEach(s => {
      if (!byProduct[s.product_id]) {
        byProduct[s.product_id] = {
          product_id: s.product_id,
          product_name: s.product_name,
          sku: s.sku,
          category: s.category_name,
          total_quantity: 0,
          cost_loss: 0,
          retail_loss: 0,
          occurrences: 0
        };
      }
      byProduct[s.product_id].total_quantity += Math.abs(parseFloat(s.quantity || 0));
      byProduct[s.product_id].cost_loss += parseFloat(s.cost_loss || 0);
      byProduct[s.product_id].retail_loss += parseFloat(s.retail_loss || 0);
      byProduct[s.product_id].occurrences++;
    });

    const topProducts = Object.values(byProduct)
      .sort((a, b) => b.cost_loss - a.cost_loss)
      .slice(0, 20);

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      shrinkage_records: shrinkageData,
      summary: {
        total_records: shrinkageData.length,
        total_quantity: totalQuantity,
        total_cost_loss: totalCostLoss,
        total_retail_loss: totalRetailLoss,
        potential_profit_loss: totalRetailLoss - totalCostLoss
      },
      by_category: Object.values(byCategory).sort((a, b) => b.cost_loss - a.cost_loss),
      by_branch: Object.values(byBranch).sort((a, b) => b.cost_loss - a.cost_loss),
      top_products: topProducts
    });
  } catch (error) {
    next(error);
  }
};

// Hourly Sales Pattern Report
exports.getHourlyReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Hourly breakdown
    const hourlyData = await sequelize.query(`
      SELECT
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as sales_count,
        SUM(total_amount) as revenue,
        AVG(total_amount) as avg_ticket,
        MIN(total_amount) as min_ticket,
        MAX(total_amount) as max_ticket
      FROM sales
      WHERE status = 'COMPLETED'
        AND created_at BETWEEN :startDate AND :endDate
        ${branch_id ? 'AND branch_id = :branchId' : ''}
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour
    `, {
      replacements: { startDate, endDate, branchId: branch_id },
      type: sequelize.QueryTypes.SELECT
    });

    // Format and add percentage
    const totalSales = hourlyData.reduce((sum, h) => sum + parseInt(h.sales_count || 0), 0);
    const totalRevenue = hourlyData.reduce((sum, h) => sum + parseFloat(h.revenue || 0), 0);

    const hourlyWithPercentage = hourlyData.map(h => ({
      hour: parseInt(h.hour),
      hour_label: `${String(h.hour).padStart(2, '0')}:00 - ${String(h.hour).padStart(2, '0')}:59`,
      sales_count: parseInt(h.sales_count),
      revenue: parseFloat(h.revenue),
      avg_ticket: parseFloat(h.avg_ticket),
      min_ticket: parseFloat(h.min_ticket),
      max_ticket: parseFloat(h.max_ticket),
      sales_percentage: totalSales > 0 ? ((parseInt(h.sales_count) / totalSales) * 100).toFixed(2) : 0,
      revenue_percentage: totalRevenue > 0 ? ((parseFloat(h.revenue) / totalRevenue) * 100).toFixed(2) : 0
    }));

    // Day of week breakdown
    const dayOfWeekData = await sequelize.query(`
      SELECT
        EXTRACT(DOW FROM created_at) as day_of_week,
        TO_CHAR(created_at, 'Day') as day_name,
        COUNT(*) as sales_count,
        SUM(total_amount) as revenue,
        AVG(total_amount) as avg_ticket
      FROM sales
      WHERE status = 'COMPLETED'
        AND created_at BETWEEN :startDate AND :endDate
        ${branch_id ? 'AND branch_id = :branchId' : ''}
      GROUP BY EXTRACT(DOW FROM created_at), TO_CHAR(created_at, 'Day')
      ORDER BY day_of_week
    `, {
      replacements: { startDate, endDate, branchId: branch_id },
      type: sequelize.QueryTypes.SELECT
    });

    // Peak hours analysis
    const peakHours = [...hourlyWithPercentage]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const slowHours = [...hourlyWithPercentage]
      .sort((a, b) => a.revenue - b.revenue)
      .slice(0, 5);

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      hourly_data: hourlyWithPercentage,
      day_of_week_data: dayOfWeekData.map(d => ({
        day_of_week: parseInt(d.day_of_week),
        day_name: d.day_name.trim(),
        sales_count: parseInt(d.sales_count),
        revenue: parseFloat(d.revenue),
        avg_ticket: parseFloat(d.avg_ticket)
      })),
      peak_hours: peakHours,
      slow_hours: slowHours,
      summary: {
        total_sales: totalSales,
        total_revenue: totalRevenue,
        avg_hourly_sales: totalSales / 24,
        avg_hourly_revenue: totalRevenue / 24
      }
    });
  } catch (error) {
    next(error);
  }
};

// Branch Comparison Report
exports.getBranchComparisonReport = async (req, res, next) => {
  try {
    const { from_date, to_date } = req.query;

    const endDate = to_date ? new Date(to_date) : new Date();
    const startDate = from_date ? new Date(from_date) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all active branches
    const branches = await Branch.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'code'],
      order: [['code', 'ASC']]
    });

    // Sales metrics by branch
    const branchMetrics = await Promise.all(branches.map(async (branch) => {
      // Sales data
      const salesData = await Sale.findOne({
        where: {
          branch_id: branch.id,
          status: 'COMPLETED',
          created_at: { [Op.between]: [startDate, endDate] }
        },
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
          [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
          [sequelize.fn('AVG', sequelize.col('total_amount')), 'avg_ticket'],
          [sequelize.fn('SUM', sequelize.col('discount_amount')), 'total_discounts']
        ]
      });

      // Payment breakdown
      const paymentData = await SalePayment.findAll({
        attributes: [
          [sequelize.fn('SUM', sequelize.col('amount')), 'total'],
          'payment_method_id'
        ],
        include: [
          {
            model: Sale,
            as: 'sale',
            where: {
              branch_id: branch.id,
              status: 'COMPLETED',
              created_at: { [Op.between]: [startDate, endDate] }
            },
            attributes: []
          },
          {
            model: PaymentMethod,
            as: 'payment_method',
            attributes: ['code', 'name']
          }
        ],
        where: { status: 'APPROVED' },
        group: ['payment_method_id', 'payment_method.id', 'payment_method.code', 'payment_method.name']
      });

      // Stock value
      const stockValue = await sequelize.query(`
        SELECT
          SUM(bs.quantity * p.cost_price) as total_cost_value,
          SUM(bs.quantity * p.selling_price) as total_retail_value,
          COUNT(DISTINCT bs.product_id) as unique_products
        FROM branch_stocks bs
        INNER JOIN products p ON bs.product_id = p.id
        WHERE bs.branch_id = :branchId
          AND p.is_active = true
      `, {
        replacements: { branchId: branch.id },
        type: sequelize.QueryTypes.SELECT
      });

      // Discrepancies
      const discrepancyData = await RegisterSession.findOne({
        where: {
          branch_id: branch.id,
          closed_at: { [Op.between]: [startDate, endDate] },
          status: { [Op.in]: ['CLOSED', 'REOPENED'] }
        },
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'session_count'],
          [sequelize.fn('SUM', sequelize.col('discrepancy_cash')), 'total_discrepancy']
        ]
      });

      // Top product
      const topProduct = await SaleItem.findOne({
        attributes: [
          [sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'revenue']
        ],
        include: [
          {
            model: Sale,
            as: 'sale',
            where: {
              branch_id: branch.id,
              status: 'COMPLETED',
              created_at: { [Op.between]: [startDate, endDate] }
            },
            attributes: []
          },
          {
            model: Product,
            as: 'product',
            attributes: ['name', 'sku']
          }
        ],
        group: ['product.id', 'product.name', 'product.sku'],
        order: [[sequelize.fn('SUM', sequelize.col('SaleItem.line_total')), 'DESC']],
        limit: 1
      });

      const sales = salesData?.toJSON();
      const stock = stockValue[0];
      const discrepancy = discrepancyData?.toJSON();

      return {
        branch_id: branch.id,
        branch_name: branch.name,
        branch_code: branch.code,
        sales: {
          total_sales: parseInt(sales?.total_sales) || 0,
          total_revenue: parseFloat(sales?.total_revenue) || 0,
          avg_ticket: parseFloat(sales?.avg_ticket) || 0,
          total_discounts: parseFloat(sales?.total_discounts) || 0
        },
        payments: paymentData.map(p => ({
          method: p.payment_method?.code,
          name: p.payment_method?.name,
          total: parseFloat(p.toJSON().total)
        })),
        inventory: {
          unique_products: parseInt(stock?.unique_products) || 0,
          cost_value: parseFloat(stock?.total_cost_value) || 0,
          retail_value: parseFloat(stock?.total_retail_value) || 0
        },
        discrepancies: {
          session_count: parseInt(discrepancy?.session_count) || 0,
          total_discrepancy: parseFloat(discrepancy?.total_discrepancy) || 0
        },
        top_product: topProduct ? {
          name: topProduct.product?.name,
          sku: topProduct.product?.sku,
          revenue: parseFloat(topProduct.toJSON().revenue)
        } : null
      };
    }));

    // Overall comparison metrics
    const totalRevenue = branchMetrics.reduce((sum, b) => sum + b.sales.total_revenue, 0);
    const totalSales = branchMetrics.reduce((sum, b) => sum + b.sales.total_sales, 0);

    const comparison = branchMetrics.map(b => ({
      ...b,
      revenue_percentage: totalRevenue > 0 ? ((b.sales.total_revenue / totalRevenue) * 100).toFixed(2) : 0,
      sales_percentage: totalSales > 0 ? ((b.sales.total_sales / totalSales) * 100).toFixed(2) : 0
    }));

    // Rankings
    const rankings = {
      by_revenue: [...comparison].sort((a, b) => b.sales.total_revenue - a.sales.total_revenue),
      by_sales_count: [...comparison].sort((a, b) => b.sales.total_sales - a.sales.total_sales),
      by_avg_ticket: [...comparison].sort((a, b) => b.sales.avg_ticket - a.sales.avg_ticket),
      by_inventory_value: [...comparison].sort((a, b) => b.inventory.retail_value - a.inventory.retail_value)
    };

    return success(res, {
      period: { start_date: startDate, end_date: endDate },
      branches: comparison,
      rankings,
      consolidated: {
        total_revenue: totalRevenue,
        total_sales: totalSales,
        total_inventory_value: branchMetrics.reduce((sum, b) => sum + b.inventory.retail_value, 0),
        total_discrepancy: branchMetrics.reduce((sum, b) => sum + b.discrepancies.total_discrepancy, 0),
        branch_count: branches.length
      }
    });
  } catch (error) {
    next(error);
  }
};
