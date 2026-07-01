import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/config';
import { checkAuth, requireAuth } from '$lib/auth';
import { registry } from '$lib/metrics';

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }

  try {
    const metrics = await registry.metrics();
    return new Response(metrics, {
      headers: {
        'Content-Type': registry.contentType,
      },
    });
  } catch (error) {
    return new Response(String(error), { status: 500 });
  }
};
