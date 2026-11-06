
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import https from "node:https";
import zlib from "node:zlib";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

const activeTransactions = new Map();
const statusThrottle = new Map();

const PAYHERO_HOST = "backend.payhero.co.ke";


// PAYHERO HTTPS REQUEST
function payheroRequest(path, method = "GET", payload = null) {
  return new Promise((resolve, reject) => {

    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: PAYHERO_HOST,
      path,
      method,

      headers: {
        "Authorization": `Basic ${process.env.PAYHERO_BASIC_AUTH}`,
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        ...(body ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        } : {})
      },

      timeout: 90000
    };

    const request = https.request(options, (response) => {

      const chunks = [];

      response.on("data", chunk => chunks.push(chunk));

      response.on("end", () => {

        let raw = Buffer.concat(chunks);

        const encoding = response.headers["content-encoding"];

        try {

          if (encoding === "gzip") {
            raw = zlib.gunzipSync(raw);
          } else if (encoding === "deflate") {
            raw = zlib.inflateSync(raw);
          } else if (encoding === "br") {
            raw = zlib.brotliDecompressSync(raw);
          }

          const text = raw.toString("utf8");

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            data = {
              message: "Invalid JSON response from PayHero",
              response: text.slice(0, 1000)
            };
          }

          console.log("PayHero HTTP:", response.statusCode);
          console.log("PayHero encoding:", encoding || "none");

          resolve({
            ok: response.statusCode >= 200 &&
                response.statusCode < 300,
            status: response.statusCode,
            data
          });

        } catch (err) {
          reject(new Error(
            `Could not decode PayHero response: ${err.message}`
          ));
        }

      });

      response.on("error", reject);

    });

    request.on("timeout", () => {
      request.destroy(new Error("PayHero request timed out"));
    });

    request.on("error", reject);

    if (body) {
      request.write(body);
    }

    request.end();

  });
}


// HEALTH CHECK
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

  if (!phone || !amount || !local_id) {
    return res.status(400).json({
      status: false,
      message: "Missing required fields"
    });
  }

  const paymentAmount = Number(amount);

  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    return res.status(400).json({
      status: false,
      message: "Invalid payment amount"
    });
  }

  let formattedPhone = String(phone).replace(/\D/g, "");

  if (
    formattedPhone.startsWith("07") ||
    formattedPhone.startsWith("01")
  ) {
    formattedPhone = "254" + formattedPhone.slice(1);
  }

  if (!/^254[17]\d{8}$/.test(formattedPhone)) {
    return res.status(400).json({
      status: false,
      message: "Invalid Kenyan phone number"
    });
  }

  if (
    !process.env.PAYHERO_BASIC_AUTH ||
    !process.env.PAYHERO_ACCOUNT_ID
  ) {
    return res.status(500).json({
      status: false,
      message: "PayHero configuration missing"
    });
  }

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

    const result = await payheroRequest(
      "/api/v2/payments",
      "POST",
      payload
    );

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

    return res.status(502).json({
      status: false,
      message: "Could not communicate with PayHero",
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

    const result = await payheroRequest(
      `/api/v2/transaction/${encodeURIComponent(id)}`,
      "GET"
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

    return res.status(502).json({
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


// SERVER START
app.listen(PORT, () => {
  console.log(`PayHero backend running ${PORT}`);
});
