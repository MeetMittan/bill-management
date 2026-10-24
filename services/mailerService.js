const nodemailer = require('nodemailer');
const Bill = require('../models/Bill');
const User = require('../models/User');

let cachedTransporter = null;
let lastUser = null;
let lastPass = null;

/**
 * Initializes and returns a Nodemailer Transporter.
 * - Supports Gmail service (service: 'gmail' using EMAIL_USER and EMAIL_PASS)
 * - Supports Custom SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
 * - Automatically strips spaces from 16-character Google App Passwords
 */
async function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
  const rawPass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || '').trim();
  const pass = rawPass.replace(/\s+/g, ''); // strip spaces from Google app passwords
  const service = process.env.SMTP_SERVICE || (user && user.toLowerCase().includes('gmail.com') ? 'gmail' : null);

  // If credentials changed or transporter not created, re-initialize
  if (!cachedTransporter || lastUser !== user || lastPass !== pass) {
    lastUser = user;
    lastPass = pass;

    // Gmail configuration
    if (user && pass && ((service && service.toLowerCase() === 'gmail') || (host && host.includes('gmail.com')) || user.toLowerCase().includes('gmail.com'))) {
      cachedTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 4000,
        greetingTimeout: 4000,
        socketTimeout: 4000
      });
      console.log(`[Nodemailer] Active transport: Gmail Service (${user})`);
      return cachedTransporter;
    }

    // Generic custom SMTP
    if (host && user && pass) {
      cachedTransporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 4000,
        greetingTimeout: 4000,
        socketTimeout: 4000
      });
      console.log(`[Nodemailer] Active transport: SMTP ${host}:${port} (${user})`);
      return cachedTransporter;
    }

    // Local JSON Transport fallback if no credentials are configured
    cachedTransporter = nodemailer.createTransport({
      jsonTransport: true
    });
  }

  return cachedTransporter;
}

/**
 * Sends Sign-In or Sign-Up Email Verification with 6-digit OTP and direct link via Nodemailer
 */
async function sendVerificationEmail(user, otp, token, type = 'signin') {
  const mailer = await getTransporter();
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const verifyLink = `${appUrl}/verify-otp?token=${token}&email=${encodeURIComponent(user.email)}`;

  const isSignIn = type === 'signin';
  const subject = isSignIn 
    ? `Your Sign-In OTP Code: ${otp} - Bill & Tax Audit Manager`
    : `Your Account Verification Code: ${otp} - Bill & Tax Audit Manager`;

  const heading = isSignIn ? 'Sign-In Verification Code' : 'Verify Your Email Address';
  const actionText = isSignIn 
    ? 'Use the 6-digit one-time password (OTP) below to securely complete your sign-in:'
    : 'Please use the following 6-digit code to complete your account registration:';

  const authUser = (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
  const fromAddress = authUser ? `"Bill & Tax Audit Manager" <${authUser}>` : (process.env.SMTP_FROM || '"Bill & Tax Audit Manager" <alerts@taxbillmanager.com>');

  const mailOptions = {
    from: fromAddress,
    to: user.email,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b; background-color: #ffffff;">
        <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 8px;">${heading}</h2>
        <p style="font-size: 14px; color: #64748b; margin-top: 0;">Hello ${user.name},</p>
        
        <p style="font-size: 14px; line-height: 1.5;">${actionText}</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 18px; text-align: center; margin: 24px 0;">
          <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #0f172a; font-family: monospace;">${otp}</span>
          <p style="font-size: 12px; color: #64748b; margin: 8px 0 0 0;">This code is valid for 10 minutes. Do not share it with anyone.</p>
        </div>

        <p style="font-size: 14px; color: #475569;">Or click the direct confirmation link below:</p>
        <p style="margin: 16px 0;">
          <a href="${verifyLink}" style="display: inline-block; background-color: #0f172a; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">Confirm & Activate</a>
        </p>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #94a3b8; margin: 0;">If you did not request this code, please ignore this email or change your password.</p>
      </div>
    `
  };

  try {
    const info = await mailer.sendMail(mailOptions);
    console.log(`[Nodemailer SUCCESS] Verification email sent to ${user.email} (Type: ${type.toUpperCase()})`);
    return { success: true, delivered: true, messageId: info.messageId };
  } catch (error) {
    const isNetworkBlock = error.code === 'ESOCKET' || 
                           error.code === 'ETIMEDOUT' || 
                           error.code === 'ENETUNREACH' || 
                           error.code === 'ECONNREFUSED' || 
                           (error.message && error.message.toLowerCase().includes('timeout'));
    console.error(`[Nodemailer ERROR] Failed to send email to ${user.email}:`, error.message);
    if (isNetworkBlock) {
      console.warn(`[Nodemailer NOTICE] Network/Firewall blocked outbound SMTP. Providing OTP in session/fallback so account verification is not blocked.`);
    } else if (error.message && (error.message.includes('Invalid login') || error.message.includes('Username and Password not accepted'))) {
      console.error('[Nodemailer TIP] For Gmail: Generate a 16-character App Password at https://myaccount.google.com/apppasswords and set EMAIL_PASS in .env');
    }
    return { 
      success: true, 
      delivered: false, 
      networkBlocked: isNetworkBlock, 
      otp: isNetworkBlock ? otp : undefined,
      messageId: `fallback-${Date.now()}`, 
      error: error.message 
    };
  }
}

/**
 * Sends a bill due date reminder email to user (uses ₹)
 */
async function sendDueReminderEmail(user, bill) {
  const mailer = await getTransporter();
  const formattedDueDate = bill.dueDate ? new Date(bill.dueDate).toLocaleDateString() : 'Upcoming';
  const amountStr = `₹${bill.grandTotal.toFixed(2)}`;

  const mailOptions = {
    from: process.env.SMTP_FROM || '"Bill & Tax Audit Manager" <alerts@taxbillmanager.com>',
    to: user.email,
    subject: `Payment Reminder: Bill from ${bill.vendorName} is due in 3 days (${amountStr})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b; background-color: #ffffff;">
        <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 8px;">Bill Payment Due Reminder</h2>
        <p style="font-size: 14px; color: #64748b; margin-top: 0;">Hello ${user.name}, this is an automated alert for an upcoming invoice payment:</p>
        
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <p style="margin: 4px 0; font-size: 14px;"><strong>Vendor:</strong> ${bill.vendorName}</p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Invoice #:</strong> ${bill.invoiceNumber || 'N/A'}</p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Category:</strong> ${bill.categoryName || 'General'}</p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Due Date:</strong> ${formattedDueDate}</p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Amount Due:</strong> <span style="font-size: 16px; color: #0f172a; font-weight: 700;">${amountStr}</span></p>
          <p style="margin: 4px 0; font-size: 14px;"><strong>Tax:</strong> ₹${bill.taxAmount.toFixed(2)}</p>
        </div>

        <p style="font-size: 14px; color: #475569;">Please log in to your dashboard to review and manage payment status.</p>
        
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #94a3b8; margin: 0;">Bill & Tax Audit Management System</p>
      </div>
    `
  };

  try {
    const info = await mailer.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Nodemailer] Failed to send reminder to ${user.email}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Scans MongoDB for bills due in 3 days and dispatches alerts
 */
async function checkAndSendDueAlerts() {
  try {
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const windowStart = new Date(threeDaysFromNow.getTime() - 12 * 60 * 60 * 1000);
    const windowEnd = new Date(threeDaysFromNow.getTime() + 12 * 60 * 60 * 1000);

    const upcomingBills = await Bill.find({
      paymentStatus: 'Due',
      reminderSent: { $ne: true },
      dueDate: { $gte: windowStart, $lte: windowEnd }
    }).populate('user');

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
    console.error('[Nodemailer] Error running due date alerts scanner:', err.message);
  }
}

module.exports = {
  getTransporter,
  sendVerificationEmail,
  sendDueReminderEmail,
  checkAndSendDueAlerts
};
