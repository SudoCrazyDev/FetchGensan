import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Fills in the values app.json cannot hold.
 *
 * Static app.json does not expand environment variables, so the Maps key
 * used to ship as the literal text "$EXPO_PUBLIC_GOOGLE_MAPS_API_KEY" and
 * every Android map rendered grey. The EAS project id lives here for the
 * same reason: a placeholder id makes getExpoPushTokenAsync() throw, which
 * silently disables push.
 *
 * Set in .env (or the EAS build environment):
 *   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY   Maps SDK for Android/iOS key
 *   EAS_PROJECT_ID                    from `eas init`; enables push tokens
 *
 * After changing either, re-run `npx expo prebuild` for a native build --
 * the generated android/ folder bakes the values in.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const mapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  const projectId = process.env.EAS_PROJECT_ID;

  return {
    ...config,
    name: config.name ?? '',
    slug: config.slug ?? '',
    ios: {
      ...config.ios,
      config: { ...config.ios?.config, googleMapsApiKey: mapsKey },
    },
    android: {
      ...config.android,
      config: { ...config.android?.config, googleMaps: { apiKey: mapsKey } },
    },
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
