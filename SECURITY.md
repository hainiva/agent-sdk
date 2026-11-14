# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Email **security@epacific.com.vn** with a
description, the affected version and steps to reproduce. We acknowledge
reports within 2 business days and keep you informed until a fix ships.

## Supported versions

The latest minor release receives security fixes.

## Using the SDK safely

- **Never put the agent app's private key (or a test secret) in the app.**
  Only your backend signs staff assertions, after it has authenticated the
  staff member itself. Keep assertions short-lived (≤ 5 minutes) with a new
  `jti` each time; live apps use ES256/RS256.
- `getAssertion` must fetch a new assertion every time — do not cache one.
- Web: keep the default in-memory session store unless you need reloads to stay
  signed in; `localStorageStore` exposes the refresh token to any script on
  your origin.
- React Native: use `secureStoreSessionStore`; never AsyncStorage for tokens.
- Push credentials (Firebase service account, APNs .p8) are uploaded to
  HAINIVA once, by your admin or your backend — never shipped in the app, never
  committed. HAINIVA stores them encrypted and shows only fingerprints; upload
  new ones to rotate, and remove them (`null`) if they leak.
- Unregister a phone's push token before signing out on it.
- Do not log raw socket frames or API bodies in production: they carry
  customer data. The SDK's own `log` callback is already redacted.
- Every release on npm is published from GitHub Actions with
  [provenance](https://docs.npmjs.com/generating-provenance-statements); check it
  with `npm audit signatures`.
