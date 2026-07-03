# Proposal: Passwordless login (magic links)

## Context

Password resets are our #1 support ticket, and reused passwords are our biggest
account-takeover risk. This proposal replaces passwords with **magic links**: a
one-time sign-in link emailed to the user, with passkeys as a later follow-up.

> Out of scope for v1: passkeys/WebAuthn and SSO. Both layer on cleanly once the
> magic-link flow and token store are in place.

## How it works

1. The user enters their email and requests a link
2. We mint a single-use token and email a sign-in URL
   - the token is hashed at rest; the email carries the raw token
   - opening the link exchanges it for a session and burns the token
3. Expired or already-used tokens show a "request a new link" screen

## Token settings

| Setting | Value | Notes |
| --- | --- | --- |
| Token length | 32 bytes | base64url in the URL |
| Lifetime | 15 min | short, since email is usually fast |
| One-time use | yes | burned on exchange |

## Open questions

```choice
id: lifetime
prompt: How long should a magic link stay valid?
options:
  - 15 minutes — tightest; fine if email delivery is fast
  - 1 hour — friendlier for slow inboxes
  - 24 hours — most forgiving, but the largest attack window
```

```choice
id: channels
prompt: Which delivery channels should v1 support?
multi: true
options:
  - Email
  - SMS
  - Authenticator push
```

## Rollout checklist

- [ ] Token store with hashing + single-use burn
- [ ] Email template and delivery
- [ ] Sign-in and "expired link" screens
- [ ] Metrics: request rate, exchange rate, failures
- [ ] Enable behind the `magic-link` flag in staging

```js
// minting a link
const token = base64url(randomBytes(32));
await store.put(hash(token), { email, exp: Date.now() + 15 * 60_000 });
sendEmail(email, `${BASE}/auth/magic?t=${token}`);
```
