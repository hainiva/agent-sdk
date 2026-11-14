# Expo staff app sample

A minimal staff app: sign in through your signer, set a status, ring even when
the app is killed, answer with LiveKit, hold, hang up, wrap up.

Needs a development build (`npx expo run:android` / `run:ios`), not Expo Go.

## Setup

1. **Agent app** on HAINIVA with your bundle id in `allowedBundleIds`
   (`com.example.agentapp` here is a placeholder — use your own).
2. **Push credentials** on that agent app, so rings reach phones through YOUR
   app: Organization → Developer → Agent apps → the bell, or
   `PUT /v1/agent-apps/:id/push-credentials`:
   - Android: your Firebase project's service-account key file (Firebase
     console → Project settings → Service accounts → Generate new private key);
   - iPhone: an APNs key (.p8) from Apple Developer → Keys with "Apple Push
     Notifications service", its Key ID, your Team ID, the bundle id as topic,
     and `sandbox` for development builds or `production` for TestFlight /
     App Store.
   HAINIVA checks them with Google / Apple before saving and never shows them again.
3. Put your Firebase `google-services.json` next to `app.json` (do not commit it).
4. In `src/hainiva.ts` set `tenantId`, `bundleId` and `signer`, and replace
   `myLoginToken()` with your own login.

```sh
npm install
npx expo prebuild
npx expo run:android   # or run:ios
```

## How a ring reaches the phone

- **Android**: HAINIVA sends an FCM data message with your credentials:
  `{type: "call", tenantId, interactionId, conversationId, path, caller, line, expiresAt}`
  (and `{type: "call_cancel", interactionId, reason}` when it ends). The
  background handler shows the system call screen with `showIncomingCall`.
- **iPhone**: HAINIVA sends a PushKit VoIP push to `<bundle id>.voip` with the
  same fields; `@hainiva/react-native-call` reports it to CallKit natively.
  iOS requires a CallKit call for every VoIP push, so ring ends are not pushed:
  the SDK's socket (`call.ended`) stops the ring.
- **Answer** on either screen → `agent.calls.accept(id)` → LiveKit.

## Sign-out

`signOut()` unregisters this phone's push token first, clears the ring tenant,
then ends the session. HAINIVA also stops pushing to a phone whose sign-in has
ended.
