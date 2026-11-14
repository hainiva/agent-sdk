# @hainiva/agent-sdk samples

| Sample | What it shows |
| --- | --- |
| [`node-signer`](./node-signer) | Your backend's assertion signer (ES256, plain Node), key generation and registration; a headless agent in Node |
| [`expo-agent-app`](./expo-agent-app) | A React Native (Expo) staff app: sign-in through the signer, status, rings while the app is killed (`@hainiva/react-native-call` + your FCM / APNs credentials), answer with LiveKit, wrap-up |
| [`web-softphone`](./web-softphone) | A minimal browser softphone |

All three sign in the same way: the app asks **your backend** for a fresh
assertion, your backend authenticates the staff member with **your own** login
and signs it, and the SDK exchanges it for a HAINIVA session. Nothing in these
samples is a real HAINIVA id or secret: replace `YOUR_ORGANISATION_ID`,
`com.example.agentapp` and the example URLs with your own.
