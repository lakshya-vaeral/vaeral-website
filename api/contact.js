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
      ].join('\n'),
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border-radius:16px 16px 0 0;border-bottom:2px solid #6c63ff;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">New Contact Inquiry</h1>
                    <p style="margin:0;font-size:13px;color:#8b8fa3;">vaeral.com · ${submittedAt}</p>
                  </td>
                  <td align="right" valign="top">
                    <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#6c63ff,#3b82f6);display:inline-block;text-align:center;line-height:42px;font-size:20px;color:#fff;">✉</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:0;background-color:#111827;">

              <!-- Contact Details -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 40px;">
                <tr>
                  <td style="padding-bottom:24px;">
                    <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Full Name</p>
                    <p style="margin:0;font-size:18px;color:#f1f5f9;font-weight:600;">${name}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:24px;">
                    <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Email Address</p>
                    <a href="mailto:${email}" style="font-size:16px;color:#60a5fa;text-decoration:none;font-weight:500;">${email}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:8px;">
                    <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6c63ff;font-weight:600;">Phone Number</p>
                    <a href="tel:${phone}" style="font-size:16px;color:#60a5fa;text-decoration:none;font-weight:500;">${phone}</a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 40px;">
                    <div style="height:1px;background:linear-gradient(90deg,transparent,#374151,transparent);"></div>
                  </td>
                </tr>
              </table>

              <!-- Quick Action -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 40px 32px;">
                <tr>
                  <td align="center">
                    <a href="mailto:${email}?subject=Re: Your inquiry on Vaeral" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#6c63ff,#3b82f6);color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;letter-spacing:0.3px;">Reply to ${name.split(' ')[0]}</a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;background-color:#0d1117;border-radius:0 0 16px 16px;border-top:1px solid #1e293b;">
              <p style="margin:0;font-size:12px;color:#4b5563;text-align:center;">
                Sent from the contact form at <a href="https://www.vaeral.com" style="color:#6c63ff;text-decoration:none;">vaeral.com</a><br>
                Source: ${sourcePage}
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
