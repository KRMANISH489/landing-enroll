const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const twilio = require("twilio");
const nodemailer = require("nodemailer");

dotenv.config();

const app = express();
app.use(express.json());

// Allowed origins for CORS (to allow frontend to access this backend)
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

// Razorpay instance for handling payment operations
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Twilio instance for sending WhatsApp messages
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// In-memory storage for orders (you can use a database in production)
const ordersStore = new Map();

// Normalize WhatsApp number format (add country code if missing)
function normalizeWhatsapp(input) {
  let s = String(input || "").trim().replace(/\s+/g, "");
  s = s.replace(/^\+/, ""); // Remove leading +
  if (/^\d{10}$/.test(s)) s = "91" + s;  // Add country code
  if (!/^\d{11,15}$/.test(s)) return null;
  return `whatsapp:+${s}`;
}

// Send Email function using Nodemailer
const sendEmail = async (recipientEmail, userData) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const studentLink = `${process.env.DELIVERY_URL_BASE}/student/${userData.email}`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: recipientEmail,
    subject: "Payment Received - Enrollment Confirmation",
    html: `
      <h3>Congratulations on Your Enrollment!</h3>
      <p>Dear ${userData.name},</p>
      <p>Thank you for enrolling. Your payment has been successfully processed. Below are the details:</p>
      <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">
        <tr><th>Name</th><td>${userData.name}</td></tr>
        <tr><th>Email</th><td>${userData.email}</td></tr>
        <tr><th>WhatsApp</th><td>${userData.whatsapp}</td></tr>
        <tr><th>Amount Paid</th><td>₹${userData.amount / 100}</td></tr>
      </table>
      <p>Here is your personalized access link: <a href="${studentLink}">${studentLink}</a></p>
      <p>We look forward to having you in the course!</p>
      <p>Best regards,</p>
      <p>Your Team</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully to:", recipientEmail);
  } catch (error) {
    console.error("Error sending email:", error);
  }
};

// Send SMS (WhatsApp message) function using Twilio
const sendSMS = async (recipientPhone, userData) => {
  const msg = `✅ Payment Successful! \n\nDear ${userData.name},\nYour enrollment is confirmed. You paid ₹${userData.amount / 100}.\nCheck your email for further details and your access link.\n\nBest regards,\nYour Team`;

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: recipientPhone,
      body: msg,
    });
    console.log("SMS sent successfully to:", recipientPhone);
  } catch (error) {
    console.error("Error sending SMS:", error);
  }
};

// Health check route
app.get("/health", (req, res) => res.json({ ok: true }));

// Create Razorpay order route
app.post("/api/create-order", async (req, res) => {
  try {
    const { name, email, whatsapp } = req.body;
    console.log("Request Data:", req.body);  // Log the incoming request

    if (!name || !email || !whatsapp) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const wa = normalizeWhatsapp(whatsapp);
    if (!wa) return res.status(400).json({ error: "Invalid WhatsApp number" });

    const amount = 1499 * 100;  // ₹1499 -> paise

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: { name, email, whatsapp: wa },
    });

    // Store the order in-memory
    ordersStore.set(order.id, { name, email, whatsapp: wa, amount });

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Error creating order:", err);  // Log error
    return res.status(500).json({ error: "Server error" });
  }
});

// Verify payment signature and send confirmation email and SMS
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    console.log("Verifying Payment...");
    console.log("razorpay_order_id:", razorpay_order_id);
    console.log("razorpay_payment_id:", razorpay_payment_id);
    console.log("razorpay_signature:", razorpay_signature);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields" });
    }

    // Fetch the order details from the store
    const record = ordersStore.get(razorpay_order_id);
    if (!record) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Verify the Razorpay signature
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    // If signature is invalid
    if (expected !== razorpay_signature) {
      console.error("Invalid signature.");
      return res.status(400).json({ error: "Invalid signature" });
    }

    // Generate a unique token for the student access URL
    const token = crypto.randomBytes(24).toString("hex");
    record.token = token;
    record.paymentId = razorpay_payment_id;
    ordersStore.set(razorpay_order_id, record);

    // Create the personalized link for the student
    const url = `${process.env.DELIVERY_URL_BASE}?token=${token}`;

    // Log for debugging
    console.log("Sending email to:", record.email);
    console.log("Sending WhatsApp message to:", record.whatsapp);

    // Send confirmation email
    await sendEmail(record.email, {
      name: record.name,
      email: record.email,
      whatsapp: record.whatsapp,
      amount: record.amount,
    });

    // Send confirmation WhatsApp message
    await sendSMS(record.whatsapp, {
      name: record.name,
      amount: record.amount,
    });

    // Return a success response
    return res.json({ ok: true, urlSent: true });
  } catch (err) {
    console.error("Error in verify-payment:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Backend running on http://localhost:${port}`));
