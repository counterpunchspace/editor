# Infrastructure & Services Strategy

## Overview

Cloudflare ecosystem for hosting font editor app, user accounts, billing, and AI assistant infrastructure.

## Platform: Cloudflare

### Why Cloudflare

- Unified ecosystem: single dashboard, shared auth
- Edge computing: global latency benefits
- R2 zero-egress pricing: critical for future CDN billing
- Cost transparency: built-in analytics
- Workers bindings: direct D1/R2 access without network hops

## Architecture

```
├── Pages (app.domain.com)           - Main font editor (static)
├── Pages (account.domain.com)       - User dashboard & billing
├── Worker (/api/claude)             - Streaming AI relay + metering
├── Worker (/api/auth/request)       - Passwordless login codes
├── Worker (/api/auth/verify)        - Code verification
├── Worker (/api/stripe/webhook)     - Stripe event handler
├── Worker (cron: hourly)            - Aggregate usage → Stripe
├── D1 Database                      - User accounts, usage logs, sessions
├── KV                               - Auth codes, session tokens
└── R2 Storage (future)              - CDN assets, zero-egress
```

## Service Mapping

### App Hosting

**Cloudflare Pages**

- Static font editor build
- Automatic GitHub integration
- Preview deployments for feature branches
- Password-protected preview access
- Custom domains
- Free tier sufficient initially

### Analytics

**Cloudflare Web Analytics** (free, privacy-focused)

- No cookies required
- Basic traffic metrics
- OR **Zaraz** for advanced tracking

### AI Assistant Relay

**Cloudflare Workers**

- Proxy Claude API calls
- Streaming support for word-by-word typing effect
- Token metering per request
- Rate limiting per user
- Cost: $5/month for 10M requests

**Implementation pattern:**

```javascript
// Stream Claude response, capture usage
const response = await fetch('https://api.anthropic.com/v1/messages', {
  stream: true,
  headers: { 'anthropic-version': '2023-06-01', ... }
});

const stream = response.body.pipeThrough(new TransformStream({
  transform(chunk, controller) {
    // Parse SSE events
    // Extract token usage from final event
    // Write to D1: INSERT INTO usage (user_id, tokens, cost_usd, timestamp)
    controller.enqueue(chunk);
  }
}));

return new Response(stream, {
  headers: { 'Content-Type': 'text/event-stream' }
});
```

### Database

**Cloudflare D1** (SQLite, serverless)

- User accounts
- Usage logs (source of truth)
- Session data
- Fully managed, automatic replication
- Free tier: 5GB storage, 1B reads/month
- Paid: $0.75/million reads after free tier

**Schema:**

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  stripe_customer_id TEXT,
  created_at INTEGER
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  service TEXT, -- 'claude' or 'cdn'
  tokens INTEGER,
  cost_usd REAL,
  timestamp INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT,
  expires_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

**Alternative for sessions:**
**KV** - Simple key-value, faster reads for session lookups

### Authentication

**Passwordless with login codes**

**Email service: Resend**

- Modern transactional email API
- Excellent deliverability
- $20/month for 50k emails (100/day free tier)
- Simple Worker integration

**Flow:**

1. User enters email
2. Worker generates 6-digit code
3. Store in KV with 10min TTL
4. Send via Resend API
5. User enters code
6. Worker verifies, creates session in KV
7. Return JWT or session token

**KV for auth codes:**

```javascript
// Store code
await env.AUTH_CODES.put(`code:${email}`, code, {
  expirationTtl: 600, // 10 minutes
});

// Verify and delete
const storedCode = await env.AUTH_CODES.get(`code:${email}`);
if (storedCode === userCode) {
  await env.AUTH_CODES.delete(`code:${email}`);
  // Create session...
}
```

**Security:**

- Rate limit login attempts per email (Durable Objects or KV counter)
- One-time use codes
- 10min expiry
- HTTPS only, secure cookies
- CORS restricted to app domain

### Billing

**Stripe**

- Metered SaaS billing model
- Monthly credits, then pay-per-use
- Usage-based pricing with markup

**Metering pattern (local-first):**

```javascript
// Per request: Fast D1 insert (~5ms)
await env.DB.prepare(
  'INSERT INTO usage (user_id, service, tokens, cost_usd, timestamp) VALUES (?, ?, ?, ?, ?)'
).bind(userId, 'claude', tokens, costUSD, Date.now()).run();

// Cron Worker (hourly): Aggregate and sync to Stripe
const hourlyUsage = await env.DB.prepare(
  'SELECT user_id, SUM(tokens) as total FROM usage
   WHERE timestamp > ? AND synced = 0
   GROUP BY user_id'
).bind(lastSyncTime).all();

for (const {user_id, total} of hourlyUsage.results) {
  await stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
    quantity: total,
    timestamp: 'now'
  });
}

// Mark as synced
await env.DB.prepare('UPDATE usage SET synced = 1 WHERE timestamp > ?')
  .bind(lastSyncTime).run();
```

**Why not direct Stripe billing per request?**

- Adds 200-500ms latency to every Claude call
- Defeats streaming UX
- Stripe rate limits
- Reliability issues
- D1 is source of truth for dispute resolution

**Sync frequency:**

- Hourly: Near-real-time billing, good balance
- Daily: Simpler, fine for monthly billing cycles
- On-demand: Trigger when user views dashboard

### User Dashboard

**Cloudflare Pages** (separate site or subdomain)

- Login/logout
- View current month usage
- Billing history
- Stripe customer portal for payment methods
- Monthly credit balance

**Data flow:**

- Frontend → Worker → D1 (read usage)
- Frontend → Worker → Stripe (manage payment)
- Stripe webhooks → Worker → D1 (update subscription status)

### Future: CDN Asset Hosting

**Cloudflare R2**

- S3-compatible object storage
- **Zero egress fees** (only storage costs)
- $0.015/GB/month storage
- Critical for predictable CDN billing

**Cost tracking:**

```javascript
// Worker intercept upload
export default {
  async fetch(request, env) {
    const file = await request.formData().get("file");
    const sizeGB = file.size / 1024 / 1024 / 1024;
    const monthlyCost = sizeGB * 0.015;

    // Store in R2
    await env.CDN_BUCKET.put(key, file.stream());

    // Log cost to D1
    await env.DB.prepare(
      "INSERT INTO usage (user_id, service, cost_usd, timestamp) VALUES (?, ?, ?, ?)"
    )
      .bind(userId, "cdn", monthlyCost, Date.now())
      .run();
  },
};
```

**Billing:**

- Track storage per user
- Bill monthly with markup
- Stripe metered billing (same pattern as Claude)

## Deployment Pipeline

**GitHub → Cloudflare Pages (automatic)**

- Push to `main` → production deployment
- Push to `develop` → preview deployment (password-protected)
- Feature branches → preview URLs
- Versioning via Git tags
- Rollback via Pages dashboard

**Private version access:**

- Pages Access (Cloudflare's auth layer)
- Password-protect preview deployments
- OR custom auth in Worker

## Cost Estimates

### Initial (<1000 users)

- **Cloudflare Pages**: Free
- **Cloudflare Workers**: $5/month (paid plan for D1 access)
- **Cloudflare D1**: Free tier sufficient
- **Cloudflare KV**: Free tier sufficient
- **Cloudflare Analytics**: Free
- **Resend**: $20/month (or free tier if <100 emails/day)
- **Stripe**: Free + transaction fees (2.9% + $0.30)
- **Total**: ~$25/month

### Growth (10k users, moderate AI usage)

- **Workers**: $5/month (unless >10M requests)
- **D1**: ~$10/month (estimated)
- **KV**: ~$5/month (estimated)
- **Resend**: $20-35/month
- **Stripe**: Transaction fees only
- **Total**: ~$45-55/month + Stripe fees

### At Scale

R2 storage costs scale linearly, but zero egress keeps bandwidth costs predictable. Workers and D1 auto-scale without configuration.

## Migration Notes

- Start with free tiers
- Upgrade Workers plan when D1 access needed ($5/month)
- Monitor D1 usage via Cloudflare dashboard
- Set up billing alerts in Cloudflare
- Stripe test mode for development

## Alternative Considerations

**If complex backend logic needed beyond Workers:**

- **Vercel** + Neon Postgres: Good DX, but bandwidth costs
- **Railway**: Built-in Postgres, but lose R2 zero-egress advantage

**Cloudflare wins for:**

- Edge computing benefits (Claude streaming latency)
- R2 zero-egress (critical for CDN economics)
- Unified ecosystem
- Cost predictability
