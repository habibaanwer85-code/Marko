// Vercel Serverless Function — creates a real Stripe Checkout session for
// the logged-in user to subscribe to MARKO Pro. Uses the Stripe secret key
// server-side (never exposed to the browser) and Supabase to verify who's
// asking, exactly like api/chat.js does.

const SUPABASE_URL = "https://kyicwitbcerzdgirnmlz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5aWN3aXRiY2VyemRnaXJubWx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3Njg3MTMsImV4cCI6MjEwNTM0NDcxM30.c46rNEQBVQorhmoitfUg_3jM158tiSfwJks8TdvXl00";

// MARKO Pro pricing — change this number any time, no Stripe dashboard work needed.
const PRO_PRICE_EGP = 99; // price in whole Egyptian pounds

async function verifyUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

// Stripe's classic API expects form-encoded bodies with bracket notation
// for nested fields — this builds that without needing the Stripe SDK.
function toFormParams(obj, params = new URLSearchParams(), prefix = "") {
  for (const [key, value] of Object.entries(obj)) {
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => toFormParams(item, params, `${paramKey}[${i}]`));
    } else if (typeof value === "object") {
      toFormParams(value, params, paramKey);
    } else {
      params.append(paramKey, String(value));
    }
  }
  return params;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const user = await verifyUser(token);
    if (!user) {
      return res.status(401).json({ error: "لازم تسجّلي دخول الأول. / You must be logged in first." });
    }

  const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
    console.error("KEY_INFO", stripeKey.length, stripeKey.slice(0, 8));
    if (!stripeKey) {
      return res.status(500).json({ error: "STRIPE_SECRET_KEY is not set on the server." });
    }

    const { returnUrl } = req.body || {};
    const origin = returnUrl || `https://${req.headers.host}`;

    const body = toFormParams({
      mode: "subscription",
      payment_method_types: ["card"],
      success_url: `${origin}?subscribed=1`,
      cancel_url: `${origin}?subscribed=0`,
      client_reference_id: user.id,
      customer_email: user.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "egp",
            unit_amount: PRO_PRICE_EGP * 100,
            recurring: { interval: "month" },
            product_data: { name: "MARKO Pro" },
          },
        },
      ],
      metadata: { user_id: user.id },
    });

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const session = await stripeRes.json();
    if (!stripeRes.ok) {console.error("CHECKOUT_ERR", JSON.stringify(session));
      return res.status(500).json({ error: session.error?.message || "Stripe checkout session failed" });
    }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("CHECKOUT_CATCH", err.message);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}
