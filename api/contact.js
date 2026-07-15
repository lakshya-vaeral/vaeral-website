export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // Basic request size limit is handled by Vercel by default (usually 4.5MB)
  
  const { name, email, phone, message } = req.body;

  // Server-side validation
  if (!name || !email || !phone) {
    return res.status(400).json({ message: 'Name, email, and phone are required fields.' });
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format.' });
  }

  // Check for honeypot field (to prevent spam bots)
  // If the 'website' field is filled, it's likely a bot
  if (req.body.website) {
    // Return success to fool the bot, but don't send an email
    return res.status(200).json({ message: 'Message sent successfully!' });
  }

  try {
    // Dynamically import nodemailer to keep function execution fast if not needed
    const nodemailer = (await import('nodemailer')).default;

    // Configure the transporter using environment variables
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // Define the email options
    const mailOptions = {
      from: `"${name}" <${process.env.EMAIL_USER}>`, // Send from authenticated user to avoid SPF/DKIM issues
      to: 'lakshya@vaeral.com',
      replyTo: email,
      subject: `New Contact Form Inquiry - Vaeral`,
      text: `
You have received a new inquiry from the Vaeral website contact form.

Name: ${name}
Email: ${email}
Phone: ${phone}

Submitted At: ${new Date().toISOString()}
Source Page: ${req.headers.referer || 'Direct API Call'}
      `.trim(),
    };

    // Send the email
    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: 'Message sent successfully!' });
  } catch (error) {
    console.error('Error sending email:', error);
    // Do not expose stack traces to the user
    return res.status(500).json({ message: 'An internal server error occurred while sending the email.' });
  }
}
