const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const {
  Sale, SaleItem, SalePayment, Branch, CashRegister, RegisterSession,
  Customer, User, Product, PaymentMethod, Invoice, InvoiceType,
  BranchStock, StockMovement, LoyaltyTransaction, CreditTransaction,
  sequelize
} = require('../database/models');
const { success, created, paginated } = require('../utils/apiResponse');
const { NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { parsePagination, generateSaleNumber, calculateLoyaltyPoints, formatDecimal } = require('../utils/helpers');
const { EVENTS } = require('../socket');
const logger = require('../utils/logger');
const factuHoyService = require('../services/factuhoy.service');

/**
 * Get all sales with filters
 * GET /api/v1/sales
 */
exports.getAll = async (req, res, next) => {
  try {
    const { page, limit, offset, sortBy, sortOrder } = parsePagination(req.query);
    const { branch_id, session_id, customer_id, status, from_date, to_date, search } = req.query;

    const where = {};

    if (branch_id) where.branch_id = branch_id;
    if (session_id) where.session_id = session_id;
    if (customer_id) where.customer_id = customer_id;
    if (status) where.status = status;

    if (from_date || to_date) {
      where.created_at = {};
      if (from_date) where.created_at[Op.gte] = new Date(from_date);
      if (to_date) where.created_at[Op.lte] = new Date(to_date);
    }

    if (search) {
      where.sale_number = { [Op.iLike]: `%${search}%` };
    }

    // Filter by user's accessible branches if needed
    if (!req.user.permissions.canViewAllBranches) {
      where.branch_id = req.user.branch_id;
    }

    const { count, rows } = await Sale.findAndCountAll({
      where,
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'company_name'] },
        { model: SalePayment, as: 'payments', include: [{ model: PaymentMethod, as: 'payment_method' }] }
      ],
      order: [[sortBy, sortOrder]],
      limit,
      offset
    });

    const salesWithSummary = rows.map((sale) => ({
      id: sale.id,
      sale_number: sale.sale_number,
      created_at: sale.created_at,
      total_amount: sale.total_amount,
      status: sale.status,
      customer_name: sale.customer
        ? sale.customer.company_name || `${sale.customer.first_name} ${sale.customer.last_name}`
        : null,
      payment_methods: sale.payments.map((p) => p.payment_method.name),
      items_count: 0 // Would need separate query for count
    }));

    return paginated(res, salesWithSummary, {
      page,
      limit,
      total_items: count
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get sale by ID with full details
 * GET /api/v1/sales/:id
 */
exports.getById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findByPk(id, {
      include: [
        { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
        { model: CashRegister, as: 'register', attributes: ['id', 'register_number', 'name'] },
        { model: Customer, as: 'customer' },
        { model: User, as: 'seller', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'voider', attributes: ['id', 'first_name', 'last_name'] },
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'sku', 'name'] }]
        },
        {
          model: SalePayment,
          as: 'payments',
          include: [{ model: PaymentMethod, as: 'payment_method' }]
        },
        { model: Invoice, as: 'invoice' }
      ]
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    const saleData = sale.toJSON();
    saleData.branch_name = sale.branch?.name;
    saleData.register_name = sale.register?.name || `Caja ${sale.register?.register_number}`;
    saleData.customer_name = sale.customer
      ? sale.customer.company_name || `${sale.customer.first_name} ${sale.customer.last_name}`
      : null;
    saleData.seller_name = sale.seller ? `${sale.seller.first_name} ${sale.seller.last_name}` : null;
    saleData.created_by_name = `${sale.creator.first_name} ${sale.creator.last_name}`;

    return success(res, saleData);
  } catch (error) {
    next(error);
  }
};

/**
 * Create new sale
 * POST /api/v1/sales
 */
exports.create = async (req, res, next) => {
  const t = await sequelize.transaction();

  try {
    const {
      branch_id, register_id, session_id, customer_id, seller_id,
      discount_percent, discount_amount, discount_type, discount_value,
      points_redeemed, credit_used, change_as_credit, items, payments,
      local_id, local_created_at,
      invoice_override // Invoice override parameters from frontend
    } = req.body;

    // Verify session is open
    const session = await RegisterSession.findByPk(session_id);
    if (!session || session.status !== 'OPEN') {
      throw new BusinessError('Register session is not open', 'E401');
    }

    // Get branch for sale number
    const branch = await Branch.findByPk(branch_id);
    if (!branch) {
      throw new NotFoundError('Branch not found');
    }

    // Calculate sale totals
    let subtotal = 0;
    const saleItems = [];

    for (const item of items) {
      const product = await Product.findByPk(item.product_id);
      if (!product) {
        throw new NotFoundError(`Product ${item.product_id} not found`);
      }

      const lineDiscount = item.discount_percent
        ? (item.unit_price * item.quantity * item.discount_percent / 100)
        : 0;
      const lineTotal = (item.unit_price * item.quantity) - lineDiscount;
      const taxAmount = product.is_tax_included
        ? (lineTotal * product.tax_rate / (100 + parseFloat(product.tax_rate)))
        : (lineTotal * product.tax_rate / 100);

      saleItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        cost_price: product.cost_price,
        discount_percent: item.discount_percent || 0,
        discount_amount: lineDiscount,
        tax_rate: product.tax_rate,
        tax_amount: taxAmount,
        line_total: lineTotal,
        notes: item.notes
      });

      subtotal += lineTotal;
    }

    // Apply sale-level discount
    // Support both old format (discount_percent/discount_amount) and new format (discount_type/discount_value)
    let saleDiscount = 0;
    if (discount_type && discount_value) {
      // New format from frontend
      saleDiscount = discount_type === 'FIXED'
        ? discount_value
        : (discount_type === 'PERCENT' ? subtotal * discount_value / 100 : 0);
    } else {
      // Old format (backward compatibility)
      saleDiscount = discount_amount || (discount_percent ? subtotal * discount_percent / 100 : 0);
    }

    // Calculate points redemption value
    const pointsValue = points_redeemed ? points_redeemed * 1 : 0; // 1 peso per point

    // Calculate total
    const totalAmount = subtotal - saleDiscount - pointsValue - (credit_used || 0);

    // Validate payment method requirements
    for (const payment of payments) {
      const paymentMethod = await PaymentMethod.findByPk(payment.payment_method_id);
      if (!paymentMethod) {
        throw new NotFoundError(`Payment method ${payment.payment_method_id} not found`);
      }

      // Enforce requires_reference flag
      if (paymentMethod.requires_reference && !payment.reference_number) {
        throw new BusinessError(
          `${paymentMethod.name} requiere un número de comprobante/referencia`,
          'E408'
        );
      }
    }

    // Verify payments cover total
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    if (totalPaid < totalAmount) {
      throw new BusinessError('Payment amount is less than total', 'E407');
    }

    // Create sale
    const sale = await Sale.create({
      id: uuidv4(),
      sale_number: generateSaleNumber(branch.code),
      branch_id,
      register_id,
      session_id,
      customer_id,
      seller_id,
      subtotal,
      discount_amount: saleDiscount,
      discount_percent: discount_percent || 0,
      tax_amount: saleItems.reduce((sum, i) => sum + parseFloat(i.tax_amount), 0),
      total_amount: totalAmount,
      points_redeemed: points_redeemed || 0,
      points_redemption_value: pointsValue,
      credit_used: credit_used || 0,
      change_as_credit: change_as_credit || 0,
      status: 'COMPLETED',
      created_by: req.user.id,
      local_id,
      local_created_at,
      synced_at: new Date(),
      sync_status: 'SYNCED'
    }, { transaction: t });

    // Create sale items
    for (const item of saleItems) {
      await SaleItem.create({
        id: uuidv4(),
        sale_id: sale.id,
        ...item
      }, { transaction: t });

      // Update stock
      if (item.product_id) {
        const stock = await BranchStock.findOne({
          where: { branch_id, product_id: item.product_id }
        });

        if (stock) {
          const newQty = parseFloat(stock.quantity) - parseFloat(item.quantity);
          await stock.update({ quantity: newQty }, { transaction: t });

          // Create stock movement
          await StockMovement.create({
            id: uuidv4(),
            branch_id,
            product_id: item.product_id,
            movement_type: 'SALE',
            quantity: -parseFloat(item.quantity),
            quantity_before: stock.quantity,
            quantity_after: newQty,
            reference_type: 'SALE',
            reference_id: sale.id,
            performed_by: req.user.id
          }, { transaction: t });
        }
      }
    }

    // Create sale payments
    for (const payment of payments) {
      await SalePayment.create({
        id: uuidv4(),
        sale_id: sale.id,
        payment_method_id: payment.payment_method_id,
        amount: payment.amount,
        reference_number: payment.reference_number,
        card_last_four: payment.card_last_four,
        card_brand: payment.card_brand,
        authorization_code: payment.authorization_code,
        qr_provider: payment.qr_provider,
        qr_transaction_id: payment.qr_transaction_id
      }, { transaction: t });
    }

    // Handle loyalty points
    if (customer_id) {
      const customer = await Customer.findByPk(customer_id);

      // Deduct redeemed points
      if (points_redeemed > 0) {
        const newBalance = customer.loyalty_points - points_redeemed;
        await customer.update({ loyalty_points: newBalance }, { transaction: t });

        await LoyaltyTransaction.create({
          id: uuidv4(),
          customer_id,
          transaction_type: 'REDEEM',
          points: -points_redeemed,
          points_balance_after: newBalance,
          sale_id: sale.id,
          description: `Canje en venta ${sale.sale_number}`,
          created_by: req.user.id
        }, { transaction: t });
      }

      // Calculate and add earned points
      const pointsEarned = calculateLoyaltyPoints(totalAmount);
      if (pointsEarned > 0) {
        const newBalance = customer.loyalty_points + pointsEarned;
        await customer.update({ loyalty_points: newBalance }, { transaction: t });

        await LoyaltyTransaction.create({
          id: uuidv4(),
          customer_id,
          transaction_type: 'EARN',
          points: pointsEarned,
          points_balance_after: newBalance,
          sale_id: sale.id,
          description: `Puntos por venta ${sale.sale_number}`,
          created_by: req.user.id
        }, { transaction: t });

        sale.points_earned = pointsEarned;
        await sale.save({ transaction: t });
      }

      // Handle credit
      if (credit_used > 0) {
        const newCreditBalance = parseFloat(customer.credit_balance) - credit_used;
        await customer.update({ credit_balance: newCreditBalance }, { transaction: t });

        await CreditTransaction.create({
          id: uuidv4(),
          customer_id,
          transaction_type: 'DEBIT',
          amount: -credit_used,
          balance_after: newCreditBalance,
          sale_id: sale.id,
          description: `Uso de crédito en venta ${sale.sale_number}`,
          created_by: req.user.id
        }, { transaction: t });
      }

      if (change_as_credit > 0) {
        const newCreditBalance = parseFloat(customer.credit_balance) + change_as_credit;
        await customer.update({ credit_balance: newCreditBalance }, { transaction: t });

        await CreditTransaction.create({
          id: uuidv4(),
          customer_id,
          transaction_type: 'CREDIT',
          amount: change_as_credit,
          balance_after: newCreditBalance,
          sale_id: sale.id,
          description: `Vuelto como crédito de venta ${sale.sale_number}`,
          created_by: req.user.id
        }, { transaction: t });
      }
    }

    await t.commit();

    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emitToBranch(branch_id, EVENTS.SALE_CREATED, {
        sale_id: sale.id,
        sale_number: sale.sale_number,
        total_amount: sale.total_amount,
        created_by: req.user.first_name + ' ' + req.user.last_name
      });
    }

    // Return created sale with details
    const createdSale = await Sale.findByPk(sale.id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: SalePayment, as: 'payments' }
      ]
    });

    // Automatic invoice generation through FactuHoy (async, don't block response)
    setImmediate(async () => {
      try {
        await generateInvoiceForSale(sale.id, branch_id, customer_id, req.user.id, invoice_override);
      } catch (error) {
        logger.error(`Failed to generate invoice for sale ${sale.sale_number}`, {
          sale_id: sale.id,
          error: error.message
        });
      }
    });

    return created(res, createdSale);
  } catch (error) {
    await t.rollback();
    next(error);
  }
};

/**
 * Void a sale
 * POST /api/v1/sales/:id/void
 */
exports.voidSale = async (req, res, next) => {
  const t = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { reason, manager_pin } = req.body;

    const sale = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Branch, as: 'branch' },
        {
          model: RegisterSession,
          as: 'session',
          attributes: ['id', 'status', 'business_date', 'closed_at']
        },
        { model: Invoice, as: 'invoice' }
      ]
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    if (sale.status === 'VOIDED') {
      throw new BusinessError('Sale is already voided', 'E404');
    }

    // CRITICAL: Check if session is still open (cannot void sales from closed shifts)
    if (sale.session && sale.session.status === 'CLOSED') {
      throw new BusinessError(
        'Cannot void sales from closed shifts. Session was closed on ' +
        new Date(sale.session.closed_at).toLocaleDateString(),
        'E408'
      );
    }

    // CRITICAL: Check if sale is from current business day (same-day void restriction)
    const currentBusinessDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const saleBusinessDate = sale.session?.business_date || sale.created_at.toISOString().split('T')[0];

    if (saleBusinessDate !== currentBusinessDate) {
      throw new BusinessError(
        `Cannot void sales from previous days. Sale is from ${saleBusinessDate}, current business date is ${currentBusinessDate}`,
        'E409'
      );
    }

    // Check permission - either user has permission or manager authorized
    let approvedBy = null;
    if (!req.user.permissions.canVoidSale) {
      if (!manager_pin) {
        throw new BusinessError('Manager authorization required to void this sale', 'E106');
      }
      // Find manager by PIN
      const manager = await User.findOne({
        where: { pin_code: manager_pin, is_active: true },
        include: [{ model: require('../database/models').Role, as: 'role' }]
      });

      if (!manager || !manager.role.can_void_sale) {
        throw new BusinessError('Invalid manager PIN or insufficient permissions', 'E107');
      }
      approvedBy = manager.id;
    }

    // Void the sale
    await sale.update({
      status: 'VOIDED',
      voided_at: new Date(),
      voided_by: req.user.id,
      void_reason: reason,
      void_approved_by: approvedBy
    }, { transaction: t });

    // Restore stock for each item
    for (const item of sale.items) {
      const stock = await BranchStock.findOne({
        where: { branch_id: sale.branch_id, product_id: item.product_id }
      });

      if (stock) {
        const newQty = parseFloat(stock.quantity) + parseFloat(item.quantity);
        await stock.update({ quantity: newQty }, { transaction: t });

        await StockMovement.create({
          id: uuidv4(),
          branch_id: sale.branch_id,
          product_id: item.product_id,
          movement_type: 'RETURN',
          quantity: parseFloat(item.quantity),
          quantity_before: stock.quantity,
          quantity_after: newQty,
          reference_type: 'VOIDED_SALE',
          reference_id: sale.id,
          performed_by: req.user.id,
          notes: `Anulación de venta ${sale.sale_number}: ${reason}`
        }, { transaction: t });
      }
    }

    // Reverse loyalty/credit transactions if customer exists
    if (sale.customer_id) {
      const customer = await Customer.findByPk(sale.customer_id);

      // Reverse points earned
      if (sale.points_earned > 0) {
        const newBalance = customer.loyalty_points - sale.points_earned;
        await customer.update({ loyalty_points: newBalance }, { transaction: t });

        await LoyaltyTransaction.create({
          id: uuidv4(),
          customer_id: sale.customer_id,
          transaction_type: 'ADJUST',
          points: -sale.points_earned,
          points_balance_after: newBalance,
          sale_id: sale.id,
          description: `Anulación de puntos por venta ${sale.sale_number}`,
          created_by: req.user.id
        }, { transaction: t });
      }

      // Restore redeemed points
      if (sale.points_redeemed > 0) {
        const newBalance = customer.loyalty_points + sale.points_redeemed;
        await customer.update({ loyalty_points: newBalance }, { transaction: t });

        await LoyaltyTransaction.create({
          id: uuidv4(),
          customer_id: sale.customer_id,
          transaction_type: 'ADJUST',
          points: sale.points_redeemed,
          points_balance_after: newBalance,
          sale_id: sale.id,
          description: `Devolución de puntos canjeados por anulación ${sale.sale_number}`,
          created_by: req.user.id
        }, { transaction: t });
      }
    }

    // CRITICAL: Cancel invoice in FactuHoy if already invoiced
    if (sale.invoice) {
      const invoice = sale.invoice;

      // Only cancel invoices that are ISSUED (have valid CAE)
      if (invoice.status === 'ISSUED' && invoice.cae) {
        logger.info(`Cancelling invoice ${invoice.id} for voided sale ${sale.sale_number}`, {
          invoice_id: invoice.id,
          sale_id: sale.id,
          cae: invoice.cae
        });

        // Update invoice status to CANCELLED
        await invoice.update({
          status: 'CANCELLED',
          error_message: `Cancelled due to sale void: ${reason}`,
          updated_at: new Date()
        }, { transaction: t });

        // Note: Credit note generation in FactuHoy will be handled asynchronously
        // to avoid blocking the void operation. This is logged for later processing.
        logger.warn(`Invoice ${invoice.id} with CAE ${invoice.cae} cancelled - Credit note must be generated in FactuHoy`, {
          invoice_id: invoice.id,
          sale_number: sale.sale_number,
          cae: invoice.cae,
          void_reason: reason
        });

        // TODO: Implement automatic credit note generation via FactuHoy API
        // This should be done asynchronously after the void completes
      } else if (invoice.status === 'PENDING') {
        // If invoice is still pending, just mark as cancelled
        await invoice.update({
          status: 'CANCELLED',
          error_message: `Cancelled due to sale void: ${reason}`
        }, { transaction: t });

        logger.info(`Pending invoice ${invoice.id} cancelled for voided sale`);
      }
    }

    await t.commit();

    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emitToBranch(sale.branch_id, EVENTS.SALE_VOIDED, {
        sale_id: sale.id,
        sale_number: sale.sale_number,
        voided_by: req.user.first_name + ' ' + req.user.last_name,
        reason
      });

      // Alert owners
      io.emitToOwners(EVENTS.ALERT_CREATED, {
        type: 'VOIDED_SALE',
        severity: 'HIGH',
        title: `Venta anulada en ${sale.branch.name}`,
        message: `Venta ${sale.sale_number} por $${sale.total_amount} fue anulada. Motivo: ${reason}`
      }, sale.branch_id);
    }

    return success(res, sale, 'Sale voided successfully');
  } catch (error) {
    await t.rollback();
    next(error);
  }
};

/**
 * Get receipt data for printing
 * GET /api/v1/sales/:id/receipt
 */
exports.getReceipt = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findByPk(id, {
      include: [
        { model: Branch, as: 'branch' },
        { model: Customer, as: 'customer' },
        { model: User, as: 'creator', attributes: ['first_name', 'last_name'] },
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }]
        },
        {
          model: SalePayment,
          as: 'payments',
          include: [{ model: PaymentMethod, as: 'payment_method' }]
        }
      ]
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    const receipt = {
      // Header
      business_name: 'PetFood Store',
      branch_name: sale.branch.name,
      branch_address: sale.branch.address,
      branch_phone: sale.branch.phone,

      // Sale info
      sale_number: sale.sale_number,
      date: sale.created_at,
      cashier: `${sale.creator.first_name} ${sale.creator.last_name}`,

      // Customer (if any)
      customer: sale.customer ? {
        name: sale.customer.company_name || `${sale.customer.first_name} ${sale.customer.last_name}`,
        document: sale.customer.document_number
      } : null,

      // Items
      items: sale.items.map((item) => ({
        name: item.product.short_name || item.product.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount: item.discount_amount,
        total: item.line_total
      })),

      // Totals
      subtotal: sale.subtotal,
      discount: sale.discount_amount,
      points_redemption: sale.points_redemption_value,
      credit_used: sale.credit_used,
      total: sale.total_amount,

      // Payments
      payments: sale.payments.map((p) => ({
        method: p.payment_method.name,
        amount: p.amount
      })),

      // Loyalty
      points_earned: sale.points_earned,
      change_as_credit: sale.change_as_credit,

      // Footer
      message: '¡Gracias por su compra!'
    };

    return success(res, receipt);
  } catch (error) {
    next(error);
  }
};

/**
 * Issue invoice for sale
 * POST /api/v1/sales/:id/invoice
 */
exports.issueInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      invoice_type_code, customer_name, customer_document_type,
      customer_document_number, customer_tax_condition, customer_address
    } = req.body;

    const sale = await Sale.findByPk(id, {
      include: [
        { model: Branch, as: 'branch' },
        { model: Invoice, as: 'invoice' }
      ]
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    if (sale.invoice && sale.invoice.status === 'ISSUED') {
      throw new BusinessError('Invoice already issued for this sale', 'E405');
    }

    // Get invoice type
    const invoiceType = await InvoiceType.findOne({ where: { code: invoice_type_code } });
    if (!invoiceType) {
      throw new NotFoundError('Invoice type not found');
    }

    // Check if Factura A requires CUIT
    if (invoice_type_code === 'A' && !customer_document_number) {
      throw new BusinessError('Factura A requires customer CUIT', 'E202');
    }

    // TODO: Integrate with FactuHoy API here
    // For now, create pending invoice
    const invoice = await Invoice.create({
      id: uuidv4(),
      sale_id: sale.id,
      invoice_type_id: invoiceType.id,
      point_of_sale: sale.branch.factuhoy_point_of_sale || 1,
      invoice_number: 0, // Will be assigned by AFIP
      customer_name,
      customer_document_type,
      customer_document_number,
      customer_tax_condition,
      customer_address,
      net_amount: sale.subtotal,
      tax_amount: sale.tax_amount,
      total_amount: sale.total_amount,
      status: 'PENDING'
    });

    return created(res, invoice);
  } catch (error) {
    next(error);
  }
};

/**
 * Get sales by session
 * GET /api/v1/sales/session/:sessionId
 */
exports.getBySession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { page, limit, offset } = parsePagination(req.query);

    const { count, rows } = await Sale.findAndCountAll({
      where: { session_id: sessionId },
      include: [
        { model: Customer, as: 'customer', attributes: ['first_name', 'last_name', 'company_name'] },
        { model: SalePayment, as: 'payments', include: [{ model: PaymentMethod, as: 'payment_method' }] }
      ],
      order: [['created_at', 'DESC']],
      limit,
      offset
    });

    return paginated(res, rows, {
      page,
      limit,
      total_items: count
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get sales summary report
 * GET /api/v1/sales/report/summary
 */
exports.getSummaryReport = async (req, res, next) => {
  try {
    const { branch_id, from_date, to_date } = req.query;

    const where = {
      created_at: {
        [Op.between]: [new Date(from_date), new Date(to_date)]
      },
      status: 'COMPLETED'
    };

    if (branch_id) where.branch_id = branch_id;

    // Get totals
    const totals = await Sale.findOne({
      where,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_amount'],
        [sequelize.fn('SUM', sequelize.col('discount_amount')), 'total_discount'],
        [sequelize.fn('SUM', sequelize.col('tax_amount')), 'total_tax']
      ],
      raw: true
    });

    // Get voided sales
    const voided = await Sale.findOne({
      where: { ...where, status: 'VOIDED' },
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'amount']
      ],
      raw: true
    });

    // Get by payment method
    const byPaymentMethod = await SalePayment.findAll({
      include: [{
        model: Sale,
        as: 'sale',
        where: { ...where },
        attributes: []
      }, {
        model: PaymentMethod,
        as: 'payment_method',
        attributes: ['name']
      }],
      attributes: [
        [sequelize.fn('SUM', sequelize.col('SalePayment.amount')), 'total'],
        [sequelize.fn('COUNT', sequelize.col('SalePayment.id')), 'count']
      ],
      group: ['payment_method.id', 'payment_method.name'],
      raw: true
    });

    return success(res, {
      total_sales: parseInt(totals.total_sales) || 0,
      total_amount: formatDecimal(totals.total_amount || 0),
      total_discount: formatDecimal(totals.total_discount || 0),
      total_tax: formatDecimal(totals.total_tax || 0),
      voided_count: parseInt(voided.count) || 0,
      voided_amount: formatDecimal(voided.amount || 0),
      average_sale: totals.total_sales > 0
        ? formatDecimal(totals.total_amount / totals.total_sales)
        : '0.00',
      by_payment_method: byPaymentMethod.map((p) => ({
        method_name: p['payment_method.name'],
        total: formatDecimal(p.total || 0),
        count: parseInt(p.count) || 0
      }))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper function: Generate invoice for sale through FactuHoy
 * Called asynchronously after sale creation
 * @param {string} saleId - Sale ID
 * @param {string} branchId - Branch ID
 * @param {string} customerId - Customer ID (optional)
 * @param {string} userId - User ID who created the sale
 * @param {object} invoiceOverride - Optional invoice override from frontend
 * @param {string} invoiceOverride.invoice_type - Override invoice type (A/B/C)
 * @param {string} invoiceOverride.customer_cuit - Override customer CUIT
 * @param {string} invoiceOverride.customer_tax_condition - Override customer tax condition
 * @param {string} invoiceOverride.customer_address - Override customer address
 */
async function generateInvoiceForSale(saleId, branchId, customerId, userId, invoiceOverride = null) {
  try {
    // DUPLICATE PREVENTION: Check if invoice already exists for this sale
    const existingInvoice = await Invoice.findOne({
      where: { sale_id: saleId }
    });

    if (existingInvoice) {
      logger.warn(`Invoice already exists for sale ${saleId} - skipping generation`, {
        sale_id: saleId,
        existing_invoice_id: existingInvoice.id,
        status: existingInvoice.status
      });
      return existingInvoice;
    }

    // Load sale with all details
    const sale = await Sale.findByPk(saleId, {
      include: [
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }]
        },
        { model: Branch, as: 'branch' },
        { model: Customer, as: 'customer' }
      ]
    });

    if (!sale) {
      throw new Error(`Sale ${saleId} not found`);
    }

    const branch = sale.branch;
    const customer = sale.customer;

    // Determine invoice type - use override if provided, otherwise auto-determine
    let invoiceType = 'B'; // Default to B
    if (invoiceOverride && invoiceOverride.invoice_type) {
      // Use frontend-selected invoice type
      invoiceType = invoiceOverride.invoice_type;
      logger.info(`Using override invoice type: ${invoiceType}`, { sale_id: saleId });
    } else if (customer) {
      // Auto-determine based on tax conditions
      invoiceType = factuHoyService.determineInvoiceType(
        branch.tax_condition,
        customer.tax_condition,
        customer.document_number
      );
      logger.info(`Auto-determined invoice type: ${invoiceType}`, { sale_id: saleId });
    }

    // Get invoice type from database
    const invoiceTypeRecord = await InvoiceType.findOne({
      where: { code: invoiceType }
    });

    if (!invoiceTypeRecord) {
      throw new Error(`Invoice type ${invoiceType} not found in database`);
    }

    // Get next invoice number for this branch and type
    const lastInvoice = await Invoice.findOne({
      where: {
        point_of_sale: branch.factuhoy_point_of_sale || 1,
        invoice_type_id: invoiceTypeRecord.id
      },
      order: [['invoice_number', 'DESC']]
    });

    const nextInvoiceNumber = lastInvoice ? lastInvoice.invoice_number + 1 : 1;

    // Calculate net amount (before tax)
    const totalAmount = parseFloat(sale.total_amount);
    const taxAmount = parseFloat(sale.tax_amount);
    const netAmount = totalAmount - taxAmount;

    // Determine customer data - use override if provided for Type A
    const customerData = {
      name: customer ? (customer.company_name || `${customer.first_name} ${customer.last_name}`) : 'Consumidor Final',
      document_type: customer?.document_type || 'DNI',
      document_number: customer?.document_number || null,
      tax_condition: customer?.tax_condition || 'CONSUMIDOR_FINAL',
      address: customer?.address || null
    };

    // Override customer data if provided (for Invoice Type A)
    if (invoiceOverride) {
      if (invoiceOverride.customer_cuit) {
        customerData.document_number = invoiceOverride.customer_cuit;
        customerData.document_type = 'CUIT'; // CUIT implies document type is CUIT
      }
      if (invoiceOverride.customer_tax_condition) {
        customerData.tax_condition = invoiceOverride.customer_tax_condition;
      }
      if (invoiceOverride.customer_address) {
        customerData.address = invoiceOverride.customer_address;
      }
      logger.info(`Using override customer data for invoice`, {
        sale_id: saleId,
        override_data: invoiceOverride
      });
    }

    // Create invoice record with PENDING status
    const invoice = await Invoice.create({
      id: uuidv4(),
      sale_id: saleId,
      invoice_type_id: invoiceTypeRecord.id,
      point_of_sale: branch.factuhoy_point_of_sale || 1,
      invoice_number: nextInvoiceNumber,
      customer_name: customerData.name,
      customer_document_type: customerData.document_type,
      customer_document_number: customerData.document_number,
      customer_tax_condition: customerData.tax_condition,
      customer_address: customerData.address,
      net_amount: netAmount,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      status: 'PENDING',
      retry_count: 0
    });

    logger.info(`Invoice ${invoice.id} created for sale ${sale.sale_number}`, {
      invoice_id: invoice.id,
      sale_id: saleId,
      invoice_type: invoiceType,
      status: 'PENDING'
    });

    // Prepare data for FactuHoy - use the prepared customerData (with overrides applied)
    const invoiceData = {
      invoice_type: invoiceType,
      point_of_sale: branch.factuhoy_point_of_sale || 1,
      customer: {
        name: customerData.name,
        document_type: customerData.document_type,
        document_number: customerData.document_number || '0',
        tax_condition: customerData.tax_condition,
        address: customerData.address || ''
      },
      items: sale.items.map(item => ({
        description: item.product_name,
        quantity: parseFloat(item.quantity),
        unit_price: parseFloat(item.unit_price),
        tax_rate: parseFloat(item.tax_rate) || 21,
        total: parseFloat(item.total)
      })),
      totals: {
        subtotal: netAmount,
        tax_21: taxAmount, // Simplified - assuming all tax is 21%
        tax_10_5: 0,
        tax_27: 0,
        total: totalAmount
      },
      branch: branch
    };

    // Call FactuHoy API
    const result = await factuHoyService.createInvoice(invoiceData);

    if (result.success) {
      // Update invoice with CAE and success status
      await invoice.update({
        cae: result.cae,
        cae_expiration_date: result.cae_expiration,
        factuhoy_id: result.invoice_number?.toString() || null,
        factuhoy_response: result.afip_response,
        pdf_url: result.afip_response?.pdf_url || null,
        status: 'ISSUED',
        issued_at: new Date(),
        error_message: null
      });

      logger.info(`Invoice ${invoice.id} issued successfully - CAE: ${result.cae}`, {
        invoice_id: invoice.id,
        sale_id: saleId,
        cae: result.cae
      });
    } else {
      // Update invoice with error status
      await invoice.update({
        status: result.retryable ? 'PENDING' : 'FAILED',
        error_message: result.error,
        factuhoy_response: result.afip_response,
        retry_count: result.retryable ? invoice.retry_count + 1 : invoice.retry_count,
        last_retry_at: new Date()
      });

      logger.error(`Invoice ${invoice.id} failed - ${result.error}`, {
        invoice_id: invoice.id,
        sale_id: saleId,
        error: result.error,
        retryable: result.retryable
      });

      // Log the error - invoice will remain in PENDING status for manual retry
      if (result.retryable) {
        logger.info(`Invoice ${invoice.id} can be retried manually - marked as PENDING`);
      } else {
        logger.warn(`Invoice ${invoice.id} marked as FAILED - manual intervention required`);
      }
    }

    return invoice;
  } catch (error) {
    logger.error(`Error generating invoice for sale ${saleId}`, {
      sale_id: saleId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}
