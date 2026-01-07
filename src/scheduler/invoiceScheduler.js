const cron = require('node-cron');
const { checkStuckInvoices, alertStuckInvoices } = require('../workers/invoiceRetryWorker');
const { cleanQueue } = require('../queues/invoiceQueue');
const logger = require('../utils/logger');

/**
 * Initialize invoice-related scheduled tasks
 */
const initInvoiceScheduler = () => {
  // Check for stuck invoices every hour
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('Running scheduled task: Check stuck invoices');
      const count = await checkStuckInvoices();
      logger.info(`Scheduled task completed: Added ${count} stuck invoices to retry queue`);
    } catch (error) {
      logger.error('Scheduled task failed: Check stuck invoices', {
        error: error.message,
      });
    }
  });

  // Alert for invoices stuck >24 hours every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    try {
      logger.info('Running scheduled task: Alert stuck invoices');
      const count = await alertStuckInvoices();
      logger.info(`Scheduled task completed: Found ${count} invoices stuck >24 hours`);
    } catch (error) {
      logger.error('Scheduled task failed: Alert stuck invoices', {
        error: error.message,
      });
    }
  });

  // Clean old completed jobs from queue every day at 3 AM
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info('Running scheduled task: Clean invoice queue');
      await cleanQueue();
      logger.info('Scheduled task completed: Invoice queue cleaned');
    } catch (error) {
      logger.error('Scheduled task failed: Clean invoice queue', {
        error: error.message,
      });
    }
  });

  logger.info('Invoice scheduler initialized', {
    tasks: [
      'Check stuck invoices: Every hour',
      'Alert stuck invoices: Every 6 hours',
      'Clean queue: Daily at 3 AM',
    ],
  });
};

module.exports = { initInvoiceScheduler };
