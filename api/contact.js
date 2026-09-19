const WINDOW_MS = 10 * 60 * 1000;
// ponytail: per-instance memory, a KV store if spam crosses instances
const recent = new Map(); // key -> timestamps within WINDOW_MS
const BLOCKED = ['sk amin', 'ranger_rocky', 'rangerrockykhan07@gmail.com', '07846832004', ...(process.env.CONTACT_BLOCKLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)];
const digits = (v) => String(v).replace(/\D/g, '');
// Entries with 10+ digits match on the last 10 so +91/0 prefixes do not matter; 7-9 digits must match exactly.
function phoneBlocked(phone, entry) {
  const p = digits(phone), e = digits(entry);
  return e.length >= 10 ? p.slice(-10) === e.slice(-10) : e.length >= 7 && p === e;
}

// Records a hit for key and reports whether it now exceeds max within the window.
function overLimit(key, max) {
  const now = Date.now();
  for (const [k, hits] of recent) if (now - hits[hits.length - 1] >= WINDOW_MS) recent.delete(k);
  const hits = (recent.get(key) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  recent.set(key, hits);
  return hits.length > max;
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { name, email, phone } = req.body;

  // Server-side validation
  if (!name || !email || !phone) {
    return res.status(400).json({ message: 'Name, email, and phone are required fields.' });
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format.' });
  }

  // Check for honeypot field (spam bot trap)
  if (req.body.website) {
    return res.status(200).json({ message: 'Message sent successfully!' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || '';

  // Blocklist, per-IP rate limit and duplicate email+phone: silently drop like the honeypot.
  const fields = [name, email, phone].map(v => String(v).toLowerCase().trim());
  const drop = [
    BLOCKED.some(b => fields.includes(b) || phoneBlocked(phone, b)),
    overLimit(`ip:${ip}`, 2),
    overLimit(`dup:${fields[1]}|${digits(phone)}`, 1),
  ].some(Boolean);
  if (drop) {
    return res.status(200).json({ message: 'Message sent successfully!' });
  }

  try {
    const nodemailer = (await import('nodemailer')).default;

    // Gmail OAuth2 configuration
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      },
    });

    const submittedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const sourcePage = req.headers.referer || 'Direct API Call';

    const mailOptions = {
      from: `"Vaeral Contact Form" <${process.env.GMAIL_USER}>`,
      to: 'lakshya@vaeral.com',
      replyTo: email,
      subject: `New Inquiry from ${name} — Vaeral`,
      text: [
        `New inquiry from the Vaeral website.`,
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        `Phone: ${phone}`,
        '',
        `Submitted: ${submittedAt}`,
        `Source: ${sourcePage}`,
        `IP: ${ip}`,
        `User agent: ${userAgent}`,
      ].join('\n'),
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          
          <!-- Header -->
          <tr>
            <td style="padding:28px 40px 20px;background-color:#ffffff;border-radius:12px 12px 0 0;border-bottom:3px solid #6c63ff;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#1a1a1a;letter-spacing:-0.5px;">New Contact Inquiry</h1>
                    <p style="margin:0;font-size:13px;color:#888;">vaeral.com &middot; ${submittedAt}</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#888;">Source: ${sourcePage}<br>IP: ${ip}<br>User agent: ${userAgent}</p>
                  </td>
                  <td align="right" valign="top">
                    <div style="width:42px;height:42px;border-radius:10px;background:#6c63ff;display:inline-block;text-align:center;line-height:42px;font-size:20px;color:#fff;">&#9993;</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:0;background-color:#ffffff;">

              <!-- Contact Details -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 40px;">
                <tr>
                  <td style="padding-bottom:20px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Full Name</p>
                    <p style="margin:0;font-size:18px;color:#1a1a1a;font-weight:600;">${name}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:20px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Email Address</p>
                    <a href="mailto:${email}" style="font-size:16px;color:#2563eb;text-decoration:none;font-weight:500;">${email}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:8px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Phone Number</p>
                    <a href="tel:${phone}" style="font-size:16px;color:#2563eb;text-decoration:none;font-weight:500;">${phone}</a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 40px;">
                    <div style="height:1px;background-color:#e5e7eb;"></div>
                  </td>
                </tr>
              </table>

              <!-- Quick Action -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 40px 28px;">
                <tr>
                  <td align="center">
                    <a href="mailto:${email}?subject=Re: Your inquiry on Vaeral" style="display:inline-block;padding:12px 32px;background-color:#6c63ff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">Reply to ${name.split(' ')[0]}</a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 40px;background-color:#f9fafb;border-radius:0 0 12px 12px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                Sent from the contact form at <a href="https://www.vaeral.com" style="color:#6c63ff;text-decoration:none;">vaeral.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `.trim(),
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: 'Message sent successfully!' });
  } catch (error) {
    console.error('Error sending email:', error.message);
    return res.status(500).json({ message: 'An internal server error occurred while sending the email.' });
  }
}
