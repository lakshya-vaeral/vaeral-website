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

    const mailOptions = {
      from: `"Vaeral Contact Form" <${process.env.GMAIL_USER}>`,
      to: 'lakshya@vaeral.com',
      replyTo: email,
      subject: 'New Contact Form Inquiry - Vaeral',
      text: [
        'You have received a new inquiry from the Vaeral website contact form.',
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        `Phone: ${phone}`,
        '',
        `Submitted At: ${new Date().toISOString()}`,
        `Source Page: ${req.headers.referer || 'Direct API Call'}`,
      ].join('\n'),
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: 'Message sent successfully!' });
  } catch (error) {
    console.error('Error sending email:', error.message);
    return res.status(500).json({ message: 'An internal server error occurred while sending the email.' });
  }
}
