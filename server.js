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

// ✅ allowed origins (ONLY domain, no path)
const allowedOrigins = [
  "https://demo.digeesell.ae",
  "https://landing-enroll.onrender.com", // ✅ frontend url bhi add
  "http://localhost:5173",
  "http://localhost:5174",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // postman/curl
      const clean = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(clean)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

// ✅ health should NEVER fail
app.get("/health", (req, res) => res.status(200).send("OK"));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ✅ Twilio client only if env exists (else skip)
const hasTwilio =
  !!process.env.TWILIO_ACCOUNT_SID &&
  !!process.env.TWILIO_AUTH_TOKEN &&
  !!process.env.TWILIO_WHATSAPP_FROM;

const twilioClient = hasTwilio
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const ordersStore = new Map();

function normalizeWhatsapp(input) {
  let s = String(input || "").trim().replace(/\s+/g, "");
  s = s.replace(/^\+/, "");
  if (/^\d{10}$/.test(s)) s = "91" + s;
  if (!/^\d{11,15}$/.test(s)) return null;
  return `whatsapp:+${s}`;
}

// ✅ Email sender (safe)
async function sendEmail(recipientEmail, userData) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log("EMAIL_USER/EMAIL_PASS missing -> skipping email");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  const studentLink = `${process.env.DELIVERY_URL_BASE}?token=${userData.token}`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: recipientEmail,
    subject: "Payment Received - Enrollment Confirmation",
    html: `
      <h3>Congratulations on Your Enrollment!</h3>
      <p>Dear ${userData.name},</p>
      <p>Payment successful ✅</p>
      <p><b>Amount Paid:</b> ₹${userData.amount / 100}</p>
      <p>Your access link: <a href="${studentLink}">${studentLink}</a></p>
      <p>Best regards,<br/>Your Team</p>
    `,
  });

  console.log("✅ Email sent to:", recipientEmail);
}

// ✅ WhatsApp sender (safe)
async function sendSMS(recipientPhone, userData) {
  if (!hasTwilio || !twilioClient) {
    console.log("Twilio env missing -> skipping WhatsApp");
    return;
  }

  const msg = `✅ Payment Successful!

Dear ${userData.name},
You paid ₹${userData.amount / 100}.
Access link: ${userData.url}

Best regards,
Your Team`;

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM, // must be like: whatsapp:+14155238886
    to: recipientPhone,                     // must be like: whatsapp:+919xxxxxxxxx
    body: msg,
  });

  console.log("✅ WhatsApp sent to:", recipientPhone);
}

app.post("/api/create-order", async (req, res) => {
  try {
    const { name, email, whatsapp } = req.body;

    if (!name || !email || !whatsapp) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const wa = normalizeWhatsapp(whatsapp);
    if (!wa) return res.status(400).json({ error: "Invalid WhatsApp number" });

    const amount = 1499 * 100;

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: { name, email, whatsapp: wa },
    });

    ordersStore.set(order.id, { name, email, whatsapp: wa, amount });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Error creating order:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields" });
    }

    const record = ordersStore.get(razorpay_order_id);
    if (!record) return res.status(404).json({ error: "Order not found" });

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const url = `${process.env.DELIVERY_URL_BASE}?token=${token}`;

    record.token = token;
    record.paymentId = razorpay_payment_id;
    ordersStore.set(razorpay_order_id, record);

    // ✅ Respond fast to frontend (so no "Failed to fetch")
    res.json({ ok: true, urlSent: true, url });

    // ✅ Background send (but safe try/catch so server never crashes)
    (async () => {
      try {
        await sendEmail(record.email, {
          name: record.name,
          amount: record.amount,
          token,
        });
      } catch (e) {
        console.error("❌ Email failed:", e.message);
      }

      try {
        await sendSMS(record.whatsapp, {
          name: record.name,
          amount: record.amount,
          url,
        });
      } catch (e) {
        console.error("❌ WhatsApp failed:", e.message);
      }
    })();
  } catch (err) {
    console.error("Error in verify-payment:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Backend running on port ${port}`));
