import { call, type TestEnv } from './app';

export type AgentJson = {
  id: string;
  username: string;
  name: string;
  image: string | null;
  bio: string;
  trigger: { ask: string; above: number };
  engine: 'pass' | 'pi';
  repository: string | null;
  configSha: string | null;
  configError: string | null;
  createdAt: string;
  deletedAt: string | null;
};

/** Creates an agent through Site admin's route. */
export async function newAgent(
  t: TestEnv,
  adminCookie: string,
  handle = 'secagent',
  name = 'Security Agent'
) {
  const res = await call(t, '/api/admin/agents', {
    cookie: adminCookie,
    json: { handle, name },
  });
  if (res.status !== 201)
    throw new Error(`create agent failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { agent: AgentJson }).agent;
}

/** The agent's repository in the Artifacts fake. */
export async function agentRepo(t: TestEnv, handle = 'secagent') {
  const row = await t.env.DB.prepare(
    `SELECT r.artifacts_name AS name FROM agents a
     JOIN users u ON u.id = a.user_id
     JOIN repositories r ON r.id = a.repository_id
     WHERE u.username = ?`
  )
    .bind(handle)
    .first<{ name: string }>();
  return t.fake.repos.get(row!.name)!;
}

/** The agents row, plus its user's name and image. */
export async function agentRow(t: TestEnv, handle = 'secagent') {
  return t.env.DB.prepare(
    `SELECT a.*, u.name AS user_name, u.image AS user_image, u.email AS user_email
     FROM agents a JOIN users u ON u.id = a.user_id WHERE u.username = ?`
  )
    .bind(handle)
    .first<{
      user_id: string;
      repository_id: string | null;
      name: string;
      bio: string;
      trigger_ask: string;
      trigger_above: number;
      engine: string;
      config_sha: string | null;
      config_error: string | null;
      deleted_at: number | null;
      user_name: string;
      user_image: string | null;
      user_email: string;
    }>();
}
