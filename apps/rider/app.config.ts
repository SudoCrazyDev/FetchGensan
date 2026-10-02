import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Fills in the one value app.json cannot hold: the EAS project id.
 *
 * Static app.json does not expand environment variables, and a placeholder
 * id makes getExpoPushTokenAsync() throw, which silently disables push.
 *
 * Set in .env (or the EAS build environment):
 *   EAS_PROJECT_ID    from `eas init`; enables push tokens
 *
 * Maps need no key: they are MapLibre over OpenStreetMap.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = process.env.EAS_PROJECT_ID;

  return {
    ...config,
    name: config.name ?? '',
    slug: config.slug ?? '',
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
