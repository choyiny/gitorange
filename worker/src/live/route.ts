import type { Handler } from 'hono';
import type { AppEnv } from '../variables';
import { findRepo, permissionsFor } from '../lib/repos';
import {
  APPROVALS_CHANNEL,
  connectLive,
  liveConfigured,
  repoChannel,
} from './publish';

/**
 * `GET /api/live[?repo=<owner>/<name>]` (WebSocket): live-update pings for the signed-in user.
 * Every socket hears about approval inbox changes; with `repo`, also about that repository,
 * only if the user can read it.
 */
export const liveSocket: Handler<AppEnv> = async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket')
    return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
  if (!liveConfigured(c.env))
    return c.json({ error: 'Live updates are not set up on this server' }, 404);
  const channels = [APPROVALS_CHANNEL];
  const repo = c.req.query('repo');
  if (repo) {
    const [owner, name] = repo.split('/');
    const found =
      owner && name ? await findRepo(c.get('db'), owner, name) : null;
    if (!found) return c.json({ error: 'Not Found' }, 404);
    const perms = await permissionsFor(c.get('db'), found.repo, c.get('user'));
    if (!perms.read) return c.json({ error: 'Not Found' }, 404);
    channels.push(repoChannel(found.repo.id));
  }
  return connectLive(c.env, c.req.raw, channels);
};
