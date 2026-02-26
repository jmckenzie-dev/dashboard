import type { LayoutServerLoad } from './$types';
import { checkAuth, requireAuth } from '$lib/auth';
import { loadConfig } from '$lib/config';

export const load: LayoutServerLoad = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth() as never;
  }
  
  return {
    authenticated: true,
    config: {
      server: config.server,
      polling: config.polling
    }
  };
};
