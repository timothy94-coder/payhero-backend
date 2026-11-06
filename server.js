import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import https from "node:https";
import zlib from "node:zlib";

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

const PAYHERO_HOST = "backend.payhero.co.ke";

/* =====================================================
   ENV VALIDATION
===================================================== */

const requiredEnv = [
  "PAYHERO_BASIC_AUTH",
  "PAYHERO_CHANNEL_ID",
  "PAYHERO_CALLBACK_URL",
];

const missing = requiredEnv.filter(
  (key) => !process.env[key]
);

if (missing.length) {
  console.error(
    "Missing ENV variables:",
    missing.join(", ")
  );
}

/* =====================================================
   PAYHERO REQUEST HELPER
===================================================== */

function payheroRequest(
  path,
  method = "GET",
  payload = null
) {
  return new Promise((resolve, reject) => {
    const body = payload
      ? JSON.stringify(payload)
      : null;

    const options = {
      hostname: PAYHERO_HOST,
      path,
      method,
      timeout: 90000,
      headers: {
        Authorization: `Basic ${process.env.PAYHERO_BASIC_AUTH}`,
        Accept: "application/json",
        "Accept-Encoding": "identity",
        ...(body
          ? {
              "Content-Type":
                "application/json",
              "Content-Length":
                Buffer.byteLength(body),
            }
          : {}),
      },
    };

    const request = https.request(
      options,
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          try {
            let raw = Buffer.concat(chunks);

            const encoding =
              response.headers[
                "content-encoding"
              ];

            if (encoding === "gzip") {
              raw = zlib.gunzipSync(raw);
            } else if (
              encoding === "deflate"
            ) {
              raw = zlib.inflateSync(raw);
            } else if (encoding === "br") {
              raw =
                zlib.brotliDecompressSync(
                  raw
                );
            }

            const text =
              raw.toString("utf8");

            let data;

            try {
              data = JSON.parse(text);
            } catch {
              data = {
                invalid_json: true,
                raw_response:
                  text.substring(0, 2000),
              };
            }

            console.log(
              "PayHero Status:",
              response.statusCode
            );

            console.log(
              "PayHero Response:",
              JSON.stringify(
                data,
                null,
                2
              )
            );

            resolve({
              ok:
                response.statusCode >= 200 &&
                response.statusCode < 300,
              status:
                response.statusCode,
              data,
            });
          } catch (err) {
            reject(
              new Error(
                `Could not decode PayHero response: ${err.message}`
              )
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("PayHero timeout")
      );
    });

    request.on("error", reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "PayHero Backend",
    timestamp: new Date().toISOString(),
  });
});

/* =====================================================
   STK PUSH
===================================================== */

app.post("/api/runPrompt", async (req, res) => {
  try {
    console.log(
      "Incoming payment:",
      JSON.stringify(req.body, null, 2)
    );

    const {
      phone,
      amount,
      local_id,
      transaction_desc,
    } = req.body;

    if (!phone || !amount || !local_id) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields",
      });
    }

    const paymentAmount = Number(amount);

    if (
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0
    ) {
      return res.status(400).json({
        status: false,
        message: "Invalid payment amount",
      });
    }

    let formattedPhone = String(phone)
      .replace(/\D/g, "");

    if (
      formattedPhone.startsWith("07") ||
      formattedPhone.startsWith("01")
    ) {
      formattedPhone =
        "254" + formattedPhone.slice(1);
    }

    if (
      !/^254[17]\d{8}$/.test(
        formattedPhone
      )
    ) {
      return res.status(400).json({
        status: false,
        message:
          "Invalid Kenyan phone number",
      });
    }

    if (activeTransactions.has(local_id)) {
      return res.status(429).json({
        status: false,
        message:
          "Duplicate transaction blocked",
      });
    }

    activeTransactions.set(
      local_id,
      Date.now()
    );

    const payload = {
      amount: paymentAmount,

      phone_number: formattedPhone,

      channel_id: Number(
        process.env.PAYHERO_CHANNEL_ID
      ),

      provider: "m-pesa",

      external_reference: String(
        local_id
      ),

      customer_name:
        transaction_desc ||
        "Customer",

      callback_url:
        process.env.PAYHERO_CALLBACK_URL,
    };

    console.log(
      "PAYHERO PAYLOAD:"
    );

    console.log(
      JSON.stringify(
        payload,
        null,
        2
      )
    );

    const result =
      await payheroRequest(
        "/api/v2/payments",
        "POST",
        payload
      );

    if (!result.ok) {
      return res.status(502).json({
        status: false,
        message:
          "PayHero rejected request",
        payhero_status:
          result.status,
        payhero_response:
          result.data,
      });
    }

    return res.json({
      status: true,
      message:
        "STK Push accepted",
      data: result.data,
    });
  } catch (err) {
    console.error(
      "Payment Error:",
      err
    );

    return res.status(502).json({
      status: false,
      message:
        "Could not communicate with PayHero",
      error: err.message,
    });
  }
});

/* =====================================================
   CALLBACK
===================================================== */

app.post(
  "/api/payhero-callback",
  (req, res) => {
    console.log(
      "PAYHERO CALLBACK:"
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    if (
      req.body?.status === "success"
    ) {
      console.log(
        "PAYMENT SUCCESS"
      );
    } else {
      console.log(
        "PAYMENT FAILED/PENDING"
      );
    }

    res.sendStatus(200);
  }
);

/* =====================================================
   STATUS CHECK
===================================================== */

app.get(
  "/api/status/:id",
  async (req, res) => {
    try {
      const id = req.params.id;
      const now = Date.now();

      const last =
        statusThrottle.get(id);

      if (
        last &&
        now - last < 5000
      ) {
        return res.status(429).json({
          status: false,
          message: "Slow down",
        });
      }

      statusThrottle.set(id, now);

      const result =
        await payheroRequest(
          `/api/v2/transaction/${encodeURIComponent(
            id
          )}`,
          "GET"
        );

      if (!result.ok) {
        return res.status(502).json({
          status: false,
          message:
            "PayHero status request failed",
          data: result.data,
        });
      }

      return res.json(result.data);
    } catch (err) {
      console.error(
        "Status check error:",
        err
      );

      return res.status(502).json({
        status: false,
        message:
          "Status check failed",
        error: err.message,
      });
    }
  }
);

/* =====================================================
   CLEANUP
===================================================== */

setInterval(() => {
  const now = Date.now();

  for (const [key, time] of activeTransactions) {
    if (
      now - time >
      10 * 60 * 1000
    ) {
      activeTransactions.delete(key);
    }
  }

  for (const [key, time] of statusThrottle) {
    if (
      now - time >
      10 * 60 * 1000
    ) {
      statusThrottle.delete(key);
    }
  }
}, 60000);

/* =====================================================
   SERVER START
===================================================== */

app.listen(PORT, () => {
  console.log(
    `PayHero backend running on port ${PORT}`
  );

  console.log({
    basicAuth:
      !!process.env.PAYHERO_BASIC_AUTH,
    channelId:
      process.env.PAYHERO_CHANNEL_ID,
    callbackUrl:
      process.env.PAYHERO_CALLBACK_URL,
  });
});
