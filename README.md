# FetchGensan Android builds

Sideload builds for testing. This branch holds only these files and shares
no history with `master`.

| File | App | Package |
|---|---|---|
| `FetchGensan-customer-0.1.0.apk` | FetchGensan (customers) | `ph.fetchgensan.rider` |
| `FetchGensan-Rider-0.1.0.apk` | FetchGensan Rider (drivers) | `ph.fetchgensan.driver` |

Built from `master` at commit `01d2adf`.

- Works on 64-bit and 32-bit ARM phones (arm64-v8a, armeabi-v7a).
- Connects to `https://qdzvimiufnnfbjyfkjed.supabase.co`.
- Maps are OpenStreetMap, served by OpenFreeMap.

## Installing

1. On the phone, open this file on GitHub, tap the APK, then **View raw**
   (or the download button).
2. Open the downloaded file. Android asks you to allow installs from your
   browser; allow it for this install.
3. If Play Protect warns about an unknown developer, tap **Install anyway**.
   These builds are signed with a debug key, not a Play Store key.

## Before sign-in works

The Supabase project needs this repo's latest migrations and the `auth` and
`admin-users` edge functions:

```bash
npx supabase link --project-ref qdzvimiufnnfbjyfkjed
npx supabase db push
npx supabase functions deploy auth admin-users
```

Then follow "Configure Auth on the hosted project" in the main README.

## Not for the Play Store

Store builds need a real upload key, and preferably an AAB made with
`eas build`. A debug-signed APK is for testing only. Also, anyone who
installs a debug build has to uninstall it before a Play Store version will
install over it.
