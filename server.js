
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

const activeTransactions = new Map();
const statusThrottle = new Map();

const PAYHERO_URL = "https://backend.payhero.co.ke/api/v2";


// Check environment variables
if (
  !process.env.PAYHERO_BASIC_AUTH ||
  !process.env.PAYHERO_ACCOUNT_ID
) {
  console.error("Missing PayHero environment variables");
}


// Reusable PayHero request
async function payheroFetch(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 90000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${process.env.PAYHERO_BASIC_AUTH}`,
        ...options.headers,
      },
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        message: "PayHero returned a non-JSON response",
        response: text.slice(0, 1000),
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
    };

  } finally {
    clearTimeout(timeout);
  }
}


// Health check
app.get("/", (req, res) => {
  res.send("Backend alive (PayHero)");
});


// STK PUSH
app.post("/api/runPrompt", async (req, res) => {

  console.log("Incoming payment:", req.body);

  const {
    phone,
    amount,
    local_id,
    transaction_desc
  } = req.body;

  // Validate fields
  if (!phone || !amount || !local_id) {
    return res.status(400).json({
      status: false,
      message: "Missing required fields"
    });
  }

  // Validate amount
  const paymentAmount = Number(amount);

  if (
    !Number.isFinite(paymentAmount) ||
    paymentAmount <= 0
  ) {
    return res.status(400).json({
      status: false,
      message: "Invalid payment amount"
    });
  }

  // Normalize phone
  let formattedPhone = String(phone).replace(/\D/g, "");

  if (formattedPhone.startsWith("07") ||
      formattedPhone.startsWith("01")) {
    formattedPhone = "254" + formattedPhone.slice(1);
  }

  if (!/^254[17]\d{8}$/.test(formattedPhone)) {
    return res.status(400).json({
      status: false,
      message: "Invalid Kenyan phone number"
    });
  }

  if (!process.env.PAYHERO_BASIC_AUTH ||
      !process.env.PAYHERO_ACCOUNT_ID) {
    return res.status(500).json({
      status: false,
      message: "Payment configuration missing"
    });
  }

  // Prevent duplicate requests
  if (activeTransactions.has(local_id)) {
    return res.status(429).json({
      status: false,
      message: "Duplicate payment blocked"
    });
  }

  activeTransactions.set(local_id, Date.now());

  try {

    const payload = {
      phone_number: formattedPhone,
      amount: paymentAmount,
      channel_id: process.env.PAYHERO_ACCOUNT_ID,
      external_reference: String(local_id),
      customer_name: transaction_desc || "Customer",
      description: transaction_desc || "Payment"
    };

    console.log("Sending STK request to PayHero");

    const result = await payheroFetch(
      `${PAYHERO_URL}/payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    console.log("PayHero HTTP status:", result.status);
    console.log("PayHero response:", result.data);

    if (!result.ok) {

      return res.status(502).json({
        status: false,
        message:
          result.data?.message ||
          "PayHero payment request failed",
        data: result.data
      });
    }

    return res.json({
      status: true,
      message: "STK Push request accepted",
      data: result.data
    });

  } catch (err) {

    console.error("Payment error:", err);

    return res.status(500).json({
      status: false,
      message: err.name === "AbortError"
        ? "PayHero request timed out"
        : "Payment server error",
      error: err.message
    });

  }

});


// PAYHERO CALLBACK
app.post("/api/payhero-callback", (req, res) => {

  console.log(
    "PAYHERO CALLBACK:",
    JSON.stringify(req.body, null, 2)
  );

  const result = req.body;

  if (result.status === "success") {

    console.log("PAYMENT SUCCESS");

  } else {

    console.log("PAYMENT FAILED OR PENDING");

  }

  // Acknowledge callback
  res.sendStatus(200);

});


// TRANSACTION STATUS
app.get("/api/status/:id", async (req, res) => {

  const id = req.params.id;

  const now = Date.now();

  const last = statusThrottle.get(id);

  if (last && now - last < 5000) {

    return res.status(429).json({
      status: false,
      message: "Slow down"
    });

  }

  statusThrottle.set(id, now);

  try {

    const result = await payheroFetch(
      `${PAYHERO_URL}/transaction/${encodeURIComponent(id)}`,
      {
        method: "GET"
      }
    );

    if (!result.ok) {

      return res.status(502).json({
        status: false,
        message: "PayHero status request failed",
        data: result.data
      });

    }

    return res.json(result.data);

  } catch (err) {

    console.error("Status check error:", err);

    return res.status(500).json({
      status: false,
      message: "Status check failed",
      error: err.message
    });

  }

});


// CLEANUP
setInterval(() => {

  const now = Date.now();

  for (const [key, time] of activeTransactions.entries()) {

    if (now - time > 10 * 60 * 1000) {
      activeTransactions.delete(key);
    }

  }

  for (const [key, time] of statusThrottle.entries()) {

    if (now - time > 10 * 60 * 1000) {
      statusThrottle.delete(key);
    }

  }

}, 60000);


// SERVER ERRORS
process.on("uncaughtException", (err) => {
  console.error("Crash:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Promise error:", err);
});


// START SERVER
app.listen(PORT, () => {

  console.log(`PayHero backend running ${PORT}`);

});
