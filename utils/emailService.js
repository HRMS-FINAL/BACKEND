/**
 * Email service — sends OTP / password-reset emails via Twilio SendGrid's
 * HTTPS API (https://api.sendgrid.com/v3/mail/send). HTTPS is preferred
 * over SMTP because Render / many corporate networks block outbound SMTP
 * ports, and HTTPS is also faster.
 *
 * Configuration in Backend/.env:
 *   SENDGRID_API_KEY=SG.xxxxxxx          (required)
 *   SENDGRID_FROM=tescodigitals26@gmail.com  (required — must be a
 *                                         verified Sender Identity in
 *                                         your SendGrid account)
 *   SENDGRID_FROM_NAME=Tesco HRMS        (optional, defaults to 'Tesco HRMS')
 *
 * Backwards compatible — if the legacy SMTP_* vars are present and
 * SENDGRID_API_KEY is missing, we fall back to nodemailer SMTP.
 */
const nodemailer = (() => { try { return require('nodemailer'); } catch { return null; } })();

const SG_KEY     = process.env.SENDGRID_API_KEY   || '';
const SG_FROM    = process.env.SENDGRID_FROM      || process.env.SMTP_FROM || '';
const SG_NAME    = process.env.SENDGRID_FROM_NAME || 'Tesco HRMS';

function buildOtpEmail({ otp, name }) {
  const safeName = String(name || 'there').replace(/[<>]/g, '');
  return (
    '<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;color:#1e293b;">' +
      '<h2 style="color:#4CAA17;margin:0 0 16px;">Tesco HRMS — Password Reset</h2>' +
      '<p>Hi ' + safeName + ',</p>' +
      '<p>Use the One-Time Password below to reset your password. It is valid for 10 minutes.</p>' +
      '<div style="background:#F1F9EE;border:1px solid #4CAA17;border-radius:10px;padding:18px 24px;font-size:30px;font-weight:800;letter-spacing:8px;text-align:center;margin:24px 0;color:#166534;">' +
        otp +
      '</div>' +
      '<p style="font-size:13px;color:#64748b;">If you didn\'t request a password reset, you can safely ignore this email — your account is not at risk.</p>' +
      '<p style="font-size:12px;color:#94a3b8;margin-top:32px;">— Tesco Structures HRMS</p>' +
    '</div>'
  );
}

async function sendViaSendGrid({ to, otp, name }) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — Node 18+ required for SendGrid HTTPS API.');
  }
  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from:    { email: SG_FROM, name: SG_NAME },
    subject: 'Your Tesco HRMS password reset code',
    content: [
      { type: 'text/plain', value: 'Your Tesco HRMS password reset code is ' + otp + ' (valid 10 min).' },
      { type: 'text/html',  value: buildOtpEmail({ otp, name }) },
    ],
  };
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + SG_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status >= 200 && res.status < 300) {
    console.log('[email/sendgrid] OTP sent to ' + to + ' (HTTP ' + res.status + ')');
    return true;
  }
  const errBody = await res.text().catch(() => '');
  throw new Error('SendGrid HTTP ' + res.status + ': ' + errBody.slice(0, 300));
}

let smtpTransport = null;
function smtpReady() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && nodemailer);
}
function getSmtpTransport() {
  if (smtpTransport || !smtpReady()) return smtpTransport;
  smtpTransport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return smtpTransport;
}
async function sendViaSmtp({ to, otp, name }) {
  const t = getSmtpTransport();
  if (!t) throw new Error('SMTP not configured.');
  await t.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Your Tesco HRMS password reset code',
    html:    buildOtpEmail({ otp, name }),
    text:    'Your Tesco HRMS password reset code is ' + otp + ' (valid 10 min).',
  });
  console.log('[email/smtp] OTP sent to ' + to);
  return true;
}

/**
 * sendOtpEmail({ to, otp, name }) → Promise<boolean>
 *
 * Tries SendGrid HTTPS API first (preferred). Falls back to SMTP if the
 * legacy SMTP_* vars are present. If neither is configured, logs the OTP
 * to the server console and returns false so a developer can still test
 * the flow in dev.
 */
async function sendOtpEmail({ to, otp, name }) {
  // 1. SendGrid HTTPS — primary path.
  if (SG_KEY && SG_FROM) {
    try {
      return await sendViaSendGrid({ to, otp, name });
    } catch (err) {
      console.warn('[email/sendgrid] failed: ' + err.message);
      // Don't fall through to SMTP automatically — usually the cause is a
      // bad API key or unverified sender. Surface clearly.
      console.log('[email] OTP was: ' + otp + ' (sent to ' + to + ' — use this if email failed)');
      return false;
    }
  }

  // 2. SMTP — legacy fallback.
  if (smtpReady()) {
    try {
      return await sendViaSmtp({ to, otp, name });
    } catch (err) {
      console.warn('[email/smtp] failed: ' + err.message);
      console.log('[email] OTP was: ' + otp + ' (sent to ' + to + ' — use this if email failed)');
      return false;
    }
  }

  // 3. Nothing configured — print to console.
  console.log('--------------------------------------------------------');
  console.log('  Neither SendGrid nor SMTP is configured.');
  console.log('  Add SENDGRID_API_KEY + SENDGRID_FROM to Backend/.env.');
  console.log('  To:   ' + to);
  console.log('  Code: ' + otp);
  console.log('--------------------------------------------------------');
  return false;
}

module.exports = {
  sendOtpEmail,
  isConfigured: () => !!(SG_KEY && SG_FROM) || smtpReady(),
};
