const nodemailer = require('nodemailer');
const Bill = require('../models/Bill');
const User = require('../models/User');

let transporter = null;

/**
 * Initializes Nodemailer Transporter
 */
function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  } else {
    // Development / fallback test transporter (logs to console)
    transporter = {
      sendMail: async (mailOptions) => {
        console.log('[Mailer Service - DEV MODE] Email would be sent:');
        console.log(`  To: ${mailOptions.to}`);
        console.log(`  Subject: ${mailOptions.subject}`);
        console.log(`  Preview: ${(mailOptions.text || mailOptions.html || '').substring(0, 150)}...`);
        return { messageId: `dev-mock-${Date.now()}` };
      },
      verify: async () => true
    };
  }

  return transporter;
}

/**
 * Sends a bill due date reminder email to user
 */
async function sendDueReminderEmail(user, bill) {
  const mailer = getTransporter();
  const formattedDueDate = bill.dueDate ? new Date(bill.dueDate).toLocaleDateString() : 'Upcoming';
  const amountStr = `$${bill.grandTotal.toFixed(2)}`;

  const mailOptions = {
    from: process.env.SMTP_FROM || '"Audit & Tax Bill Manager" <alerts@taxbillmanager.com>',
    to: user.email,
    subject: `⚠️ Payment Reminder: Bill from ${bill.vendorName} is Due in 3 Days (${amountStr})`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #1e293b; margin-top: 0;">Payment Due Alert</h2>
        <p>Hello <strong>${user.name}</strong>,</p>
        <p>This is an automated reminder that your invoice payment is due in 3 days:</p>
        
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #f59e0b;">
          <p style="margin: 4px 0;"><strong>Vendor:</strong> ${bill.vendorName}</p>
          <p style="margin: 4px 0;"><strong>Invoice #:</strong> ${bill.invoiceNumber || 'N/A'}</p>
          <p style="margin: 4px 0;"><strong>Category:</strong> ${bill.categoryName || 'General'}</p>
          <p style="margin: 4px 0;"><strong>Due Date:</strong> ${formattedDueDate}</p>
          <p style="margin: 4px 0;"><strong>Amount Due:</strong> <span style="font-size: 1.2em; color: #dc2626; font-weight: bold;">${amountStr}</span></p>
          <p style="margin: 4px 0;"><strong>Tax (GST/VAT):</strong> $${bill.taxAmount.toFixed(2)}</p>
        </div>

        <p>Please log in to your dashboard to review, mark as paid, or inspect audit notes.</p>
        
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <small style="color: #64748b;">Audit & Tax Bill Management Application &bull; Automated Compliance Notifications</small>
      </div>
    `
  };

  try {
    const info = await mailer.sendMail(mailOptions);
    console.log(`[Mailer Service] Reminder email sent to ${user.email} for bill ${bill._id} (ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Mailer Service] Failed to send email to ${user.email}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Scans MongoDB for bills due in 3 days and dispatches alerts
 */
async function checkAndSendDueAlerts() {
  try {
    const now = new Date();
    // 3 days window (between 2.5 and 3.5 days from now)
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const windowStart = new Date(threeDaysFromNow.getTime() - 12 * 60 * 60 * 1000);
    const windowEnd = new Date(threeDaysFromNow.getTime() + 12 * 60 * 60 * 1000);

    const upcomingBills = await Bill.find({
      paymentStatus: 'Due',
      reminderSent: { $ne: true },
      dueDate: { $gte: windowStart, $lte: windowEnd }
    }).populate('user');

    console.log(`[Mailer Service] Found ${upcomingBills.length} bills due in ~3 days needing reminders.`);

    for (const bill of upcomingBills) {
      if (bill.user && bill.user.email && bill.user.emailAlertsEnabled !== false) {
        const res = await sendDueReminderEmail(bill.user, bill);
        if (res.success) {
          bill.reminderSent = true;
          await bill.save();
        }
      }
    }
  } catch (err) {
    console.error('[Mailer Service] Error running due date alerts scanner:', err.message);
  }
}

module.exports = {
  getTransporter,
  sendDueReminderEmail,
  checkAndSendDueAlerts
};

