export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { email } = req.body;

  // Server-side validation
  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format.' });
  }

  // Check for honeypot field (spam bot trap — Framer injects hidden fields)
  if (req.body.website || req.body.company) {
    return res.status(200).json({ message: 'Subscribed successfully!' });
  }

  try {
    const nodemailer = (await import('nodemailer')).default;

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
      from: `"Vaeral Newsletter" <${process.env.GMAIL_USER}>`,
      to: 'lakshya@vaeral.com',
      replyTo: email,
      subject: `New Newsletter Subscriber — ${email}`,
      text: [
        `New newsletter signup on vaeral.com`,
        '',
        `Email: ${email}`,
        '',
        `Submitted: ${submittedAt}`,
        `Source: ${sourcePage}`,
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
                    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#1a1a1a;letter-spacing:-0.5px;">New Newsletter Subscriber</h1>
                    <p style="margin:0;font-size:13px;color:#888;">vaeral.com &middot; ${submittedAt}</p>
                  </td>
                  <td align="right" valign="top">
                    <div style="width:42px;height:42px;border-radius:10px;background:#6c63ff;display:inline-block;text-align:center;line-height:42px;font-size:20px;color:#fff;">&#128232;</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:0;background-color:#ffffff;">

              <!-- Subscriber Details -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 40px;">
                <tr>
                  <td style="padding-bottom:8px;">
                    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Email Address</p>
                    <a href="mailto:${email}" style="font-size:18px;color:#2563eb;text-decoration:none;font-weight:600;">${email}</a>
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
                    <a href="mailto:${email}?subject=Welcome to the Vaeral newsletter!" style="display:inline-block;padding:12px 32px;background-color:#6c63ff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">Send Welcome Email</a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 40px;background-color:#f9fafb;border-radius:0 0 12px 12px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                Sent from the newsletter form at <a href="https://www.vaeral.com" style="color:#6c63ff;text-decoration:none;">vaeral.com</a>
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

    return res.status(200).json({ message: 'Subscribed successfully!' });
  } catch (error) {
    console.error('Error sending newsletter notification:', error.message);
    return res.status(500).json({ message: 'An internal server error occurred.' });
  }
}
