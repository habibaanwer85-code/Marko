// Vercel Serverless Function — receives real events from Stripe (payment
// succeeded, subscription canceled, etc.) and updates the subscriptions
// table accordingly. This is the ONLY place that ever marks a user as
// "Pro" — it can't be faked from the browser because Stripe cryptographically
// signs every event, and we verify that signature below before trusting it.

import crypto from "crypto";

// IMPORTANT: disables Vercel's automatic JSON body parsing for this route.
// Stripe signs the exact raw bytes of the request body, so we must read
// them ourselves before anything else touches the request.
export const config = {
  api: { bodyParser: false },
};

const SUPABASE_URL = "https://kyicwitbcerzdgirnmlz.supabase.co";

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("="))
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const computedSig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  const a = Buffer.from(computedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function upsertSubscription(serviceKey, row) {
  await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
}

async function findSubscriptionByStripeId(serviceKey, field, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?${field}=eq.${value}&select=user_id`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const rows = res.ok ? await res.json() : [];
  return rows[0]?.user_id || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !serviceKey) {
    return res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET or SUPABASE_SERVICE_ROLE_KEY is not set." });
  }

  const rawBodyBuffer = await buffer(req);
  const rawBody = rawBodyBuffer.toString("utf8");
  const signature = req.headers["stripe-signature"];

  if (!verifyStripeSignature(rawBody, signature, webhookSecret)) {
    return res.status(400).json({ error: "Invalid Stripe signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.user_id;
        if (userId) {
          await upsertSubscription(serviceKey, {
            user_id: userId,
            status: "active",
            plan: "pro",
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const userId = await findSubscriptionByStripeId(serviceKey, "stripe_subscription_id", sub.id);
        if (userId) {
          const isActive = sub.status === "active" || sub.status === "trialing";
          await upsertSubscription(serviceKey, {
            user_id: userId,
            status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
            plan: isActive ? "pro" : "free",
            stripe_customer_id: sub.customer,
            stripe_subscription_id: sub.id,
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }
      default:
        break; // ignore events we don't act on
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Webhook processing error" });
  }
}
