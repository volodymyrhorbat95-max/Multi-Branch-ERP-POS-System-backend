const Queue = require('bull');
const logger = require('../utils/logger');

// Create invoice retry queue
let invoiceQueue;
try {
  invoiceQueue = new Queue('invoice-retry', {
    redis: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
    },
    defaultJobOptions: {
      attempts: 5, // Retry up to 5 times
      backoff: {
        type: 'exponential',
        delay: 60000, // Start with 1 minute delay
      },
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for investigation
    },
  });
} catch (error) {
  logger.warn('Redis not available. Invoice queue disabled. This is OK for development.');
  invoiceQueue = null;
}

// Event handlers
if (invoiceQueue) {
  invoiceQueue.on('completed', (job, result) => {
    logger.info(`Invoice retry job ${job.id} completed`, {
      invoice_id: job.data.invoice_id,
      result,
    });
  });

  invoiceQueue.on('failed', (job, err) => {
    logger.error(`Invoice retry job ${job.id} failed`, {
      invoice_id: job.data.invoice_id,
      error: err.message,
      attempts: job.attemptsMade,
    });
  });

  invoiceQueue.on('stalled', (job) => {
    logger.warn(`Invoice retry job ${job.id} stalled`, {
      invoice_id: job.data.invoice_id,
    });
  });

  invoiceQueue.on('error', (error) => {
    logger.error('Invoice queue error:', { error: error.message });
  });
}

/**
 * Add invoice to retry queue
 * @param {string} invoiceId - Invoice ID to retry
 * @param {number} delay - Delay in milliseconds before retry
 */
const addInvoiceRetry = async (invoiceId, delay = 0) => {
  if (!invoiceQueue) {
    logger.warn(`Invoice queue not available. Skipping retry for invoice ${invoiceId}`);
    return null;
  }

  try {
    const job = await invoiceQueue.add(
      { invoice_id: invoiceId },
      {
        delay,
        jobId: `invoice-${invoiceId}`, // Prevent duplicate jobs
      }
    );

    logger.info(`Added invoice ${invoiceId} to retry queue`, {
      job_id: job.id,
      delay,
    });

    return job;
  } catch (error) {
    logger.error(`Failed to add invoice ${invoiceId} to retry queue`, {
      error: error.message,
    });
    throw error;
  }
};

/**
 * Remove invoice from retry queue
 * @param {string} invoiceId - Invoice ID to remove
 */
const removeInvoiceRetry = async (invoiceId) => {
  try {
    const jobId = `invoice-${invoiceId}`;
    const job = await invoiceQueue.getJob(jobId);

    if (job) {
      await job.remove();
      logger.info(`Removed invoice ${invoiceId} from retry queue`);
    }
  } catch (error) {
    logger.error(`Failed to remove invoice ${invoiceId} from retry queue`, {
      error: error.message,
    });
  }
};

/**
 * Get queue stats
 */
const getQueueStats = async () => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      invoiceQueue.getWaitingCount(),
      invoiceQueue.getActiveCount(),
      invoiceQueue.getCompletedCount(),
      invoiceQueue.getFailedCount(),
      invoiceQueue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    };
  } catch (error) {
    logger.error('Failed to get queue stats', { error: error.message });
    return null;
  }
};

/**
 * Clean old completed jobs
 */
const cleanQueue = async () => {
  try {
    await invoiceQueue.clean(24 * 60 * 60 * 1000); // Clean jobs older than 24 hours
    logger.info('Invoice queue cleaned');
  } catch (error) {
    logger.error('Failed to clean queue', { error: error.message });
  }
};

module.exports = {
  invoiceQueue,
  addInvoiceRetry,
  removeInvoiceRetry,
  getQueueStats,
  cleanQueue,
};
