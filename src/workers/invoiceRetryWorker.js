const { invoiceQueue } = require('../queues/invoiceQueue');
const { Invoice, InvoiceType, Sale, SaleItem, Product, Branch, Customer } = require('../database/models');
const factuHoyService = require('../services/factuhoy.service');
const logger = require('../utils/logger');

/**
 * Process invoice retry jobs
 */
invoiceQueue.process(async (job) => {
  const { invoice_id } = job.data;

  logger.info(`Processing invoice retry job for invoice ${invoice_id}`, {
    job_id: job.id,
    attempt: job.attemptsMade + 1,
  });

  try {
    // Load invoice with all related data
    const invoice = await Invoice.findByPk(invoice_id, {
      include: [
        {
          model: Sale,
          as: 'sale',
          include: [
            {
              model: SaleItem,
              as: 'items',
              include: [{ model: Product, as: 'product' }]
            },
            { model: Branch, as: 'branch' },
            { model: Customer, as: 'customer' }
          ]
        },
        { model: InvoiceType, as: 'invoice_type' }
      ]
    });

    if (!invoice) {
      throw new Error(`Invoice ${invoice_id} not found`);
    }

    // Only retry PENDING invoices
    if (invoice.status !== 'PENDING') {
      logger.info(`Invoice ${invoice_id} status is ${invoice.status}, skipping retry`);
      return { skipped: true, reason: `Status is ${invoice.status}` };
    }

    // Check retry count
    const MAX_RETRIES = 10;
    if (invoice.retry_count >= MAX_RETRIES) {
      logger.warn(`Invoice ${invoice_id} exceeded max retries (${MAX_RETRIES})`, {
        retry_count: invoice.retry_count,
      });

      await invoice.update({
        status: 'FAILED',
        error_message: `Exceeded maximum retry attempts (${MAX_RETRIES})`,
      });

      // TODO: Create alert for manual intervention
      return { failed: true, reason: 'Max retries exceeded' };
    }

    const sale = invoice.sale;
    const branch = sale.branch;
    const customer = sale.customer;

    // Prepare invoice data for FactuHoy
    const invoiceData = {
      invoice_type: invoice.invoice_type.code,
      point_of_sale: invoice.point_of_sale,
      customer: {
        name: invoice.customer_name,
        document_type: invoice.customer_document_type,
        document_number: invoice.customer_document_number,
        tax_condition: invoice.customer_tax_condition,
        address: invoice.customer_address,
      },
      items: sale.items.map(item => ({
        description: item.product_name,
        quantity: parseFloat(item.quantity),
        unit_price: parseFloat(item.unit_price),
        tax_rate: parseFloat(item.tax_rate) || 21,
        total: parseFloat(item.total),
      })),
      totals: {
        subtotal: parseFloat(invoice.net_amount),
        tax_21: parseFloat(invoice.tax_amount),
        tax_10_5: 0,
        tax_27: 0,
        total: parseFloat(invoice.total_amount),
      },
      branch: branch,
    };

    // Call FactuHoy API
    const result = await factuHoyService.createInvoice(invoiceData);

    if (result.success) {
      // Success - update invoice
      await invoice.update({
        cae: result.cae,
        cae_expiration_date: result.cae_expiration,
        factuhoy_id: result.invoice_number?.toString() || null,
        factuhoy_response: result.afip_response,
        pdf_url: result.afip_response?.pdf_url || null,
        status: 'ISSUED',
        issued_at: new Date(),
        error_message: null,
      });

      logger.info(`Invoice ${invoice_id} issued successfully on retry - CAE: ${result.cae}`, {
        job_id: job.id,
        cae: result.cae,
        attempt: job.attemptsMade + 1,
      });

      return {
        success: true,
        cae: result.cae,
        attempt: job.attemptsMade + 1,
      };
    } else {
      // Failed - update retry count
      await invoice.update({
        retry_count: invoice.retry_count + 1,
        last_retry_at: new Date(),
        error_message: result.error,
        factuhoy_response: result.afip_response,
      });

      logger.error(`Invoice ${invoice_id} retry failed - ${result.error}`, {
        job_id: job.id,
        attempt: job.attemptsMade + 1,
        retryable: result.retryable,
      });

      // If not retryable, mark as FAILED
      if (!result.retryable) {
        await invoice.update({
          status: 'FAILED',
        });

        logger.warn(`Invoice ${invoice_id} marked as FAILED (not retryable)`);
        return { failed: true, reason: 'Not retryable error' };
      }

      // Throw error to trigger Bull's retry mechanism
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error(`Error processing invoice retry job for ${invoice_id}`, {
      job_id: job.id,
      error: error.message,
      attempt: job.attemptsMade + 1,
    });

    // Re-throw to let Bull handle the retry
    throw error;
  }
});

/**
 * Scheduled task: Check for stuck PENDING invoices and add them to retry queue
 * This should be called periodically (e.g., every hour)
 */
const checkStuckInvoices = async () => {
  try {
    logger.info('Checking for stuck pending invoices...');

    // Find invoices that are PENDING and haven't been retried in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const stuckInvoices = await Invoice.findAll({
      where: {
        status: 'PENDING',
        retry_count: { [require('sequelize').Op.lt]: 10 },
        // Either never retried or last retry was more than 1 hour ago
        [require('sequelize').Op.or]: [
          { last_retry_at: null },
          { last_retry_at: { [require('sequelize').Op.lt]: oneHourAgo } }
        ]
      },
      limit: 100, // Process max 100 at a time
    });

    logger.info(`Found ${stuckInvoices.length} stuck pending invoices`);

    // Add each to retry queue
    for (const invoice of stuckInvoices) {
      const { addInvoiceRetry } = require('../queues/invoiceQueue');
      await addInvoiceRetry(invoice.id, 5000); // 5 second delay
    }

    return stuckInvoices.length;
  } catch (error) {
    logger.error('Error checking stuck invoices', { error: error.message });
    throw error;
  }
};

/**
 * Scheduled task: Create alerts for invoices stuck in PENDING for too long
 * This should be called periodically (e.g., every 6 hours)
 */
const alertStuckInvoices = async () => {
  try {
    logger.info('Checking for invoices requiring alerts...');

    // Find invoices stuck in PENDING for more than 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const alertInvoices = await Invoice.findAll({
      where: {
        status: 'PENDING',
        created_at: { [require('sequelize').Op.lt]: oneDayAgo },
      },
      include: [
        {
          model: Sale,
          as: 'sale',
          attributes: ['sale_number', 'branch_id'],
        }
      ],
    });

    logger.info(`Found ${alertInvoices.length} invoices stuck for >24 hours`);

    // TODO: Create alerts in Alert model
    for (const invoice of alertInvoices) {
      logger.warn(`Invoice ${invoice.id} stuck in PENDING for >24 hours`, {
        invoice_id: invoice.id,
        sale_number: invoice.sale?.sale_number,
        created_at: invoice.created_at,
        retry_count: invoice.retry_count,
        error_message: invoice.error_message,
      });

      // Alert creation will be implemented when Alert model is ready
      // await Alert.create({
      //   type: 'INVOICE_STUCK',
      //   severity: 'HIGH',
      //   branch_id: invoice.sale.branch_id,
      //   message: `Factura ${invoice.id} pendiente por más de 24 horas`,
      //   metadata: { invoice_id: invoice.id, sale_id: invoice.sale_id }
      // });
    }

    return alertInvoices.length;
  } catch (error) {
    logger.error('Error checking invoices for alerts', { error: error.message });
    throw error;
  }
};

module.exports = {
  checkStuckInvoices,
  alertStuckInvoices,
};
