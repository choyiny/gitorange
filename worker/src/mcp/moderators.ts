import { and, eq } from 'drizzle-orm';
import { oauthClients, oauthConsents } from '../db/auth.schema';
import { mcpModerators } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';

/** A moderator tool called from any other connection. */
export const NOT_MODERATOR =
  "This connected app isn't a moderator — turn it on in Settings → MCP server → Connected apps.";

/** A moderator connection: the app, and the name its decisions are recorded under (`via`). */
export type Moderator = { clientId: string; name: string };

/** Longest `via` recorded; the app's registered name is the client's own choice. */
const VIA_MAX = 80;

/**
 * The app's registered name as a `via`: without control, format (bidi overrides, zero-width) or line/paragraph
 * separator characters, which could disguise one app as another, and at most VIA_MAX characters.
 */
export function viaName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return Array.from(clean).slice(0, VIA_MAX).join('').trim() || 'Unnamed app';
}

/**
 * A moderator row counts only together with the very consent it was turned on under, still the user's for that app.
 * The foreign key already deletes the row with its consent; this join keeps the check in the read too, so a consent
 * revoked elsewhere (better-auth's delete-consent) and granted again is never silently a moderator.
 */
const underItsConsent = and(
  eq(oauthConsents.id, mcpModerators.consentId),
  eq(oauthConsents.userId, mcpModerators.userId),
  eq(oauthConsents.clientId, mcpModerators.clientId)
);

/**
 * The user's app as a moderator, or null. Read fresh on every MCP call that needs it — never cache it — so turning
 * it off (or disconnecting) takes effect on the next call. `name` is the app's registered name, as on the consent
 * screen and in Connected apps, cleaned by `viaName`.
 */
export async function moderatorFor(
  db: DrizzleDB,
  userId: string,
  clientId: string
): Promise<Moderator | null> {
  const row = await db
    .select({ name: oauthClients.name })
    .from(mcpModerators)
    .innerJoin(oauthConsents, underItsConsent)
    .innerJoin(oauthClients, eq(oauthClients.clientId, mcpModerators.clientId))
    .where(
      and(
        eq(mcpModerators.userId, userId),
        eq(mcpModerators.clientId, clientId)
      )
    )
    .get();
  return row ? { clientId, name: viaName(row.name) } : null;
}

/** The client ids of the user's moderator apps (for the Connected apps list); agrees with `moderatorFor`. */
export async function moderatorClientIds(
  db: DrizzleDB,
  userId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ clientId: mcpModerators.clientId })
    .from(mcpModerators)
    .innerJoin(oauthConsents, underItsConsent)
    .where(eq(mcpModerators.userId, userId))
    .all();
  return new Set(rows.map((r) => r.clientId));
}

/**
 * Turns moderator on or off for one of the user's connected apps. Turning it on needs the user's own consent for
 * that app (false otherwise: never someone else's app or an unknown id) and binds the row to that consent; both
 * directions are idempotent.
 */
export async function setModerator(
  db: DrizzleDB,
  userId: string,
  clientId: string,
  on: boolean
): Promise<boolean> {
  const mine = and(
    eq(mcpModerators.userId, userId),
    eq(mcpModerators.clientId, clientId)
  );
  if (!on) {
    await db.delete(mcpModerators).where(mine);
    return true;
  }
  const consent = await db
    .select({ id: oauthConsents.id })
    .from(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.clientId, clientId)
      )
    )
    .get();
  if (!consent) return false;
  const now = new Date();
  await db
    .insert(mcpModerators)
    .values({ userId, clientId, consentId: consent.id, createdAt: now })
    .onConflictDoUpdate({
      target: [mcpModerators.userId, mcpModerators.clientId],
      set: { consentId: consent.id, createdAt: now },
    });
  return true;
}

/**
 * The registered name of an OAuth app, cleaned by `viaName`, or null when the app is unknown. What pull requests it
 * opens record as `created_via` ("Claude Code"): the same name `via` shows for its decisions.
 */
export async function appName(
  db: DrizzleDB,
  clientId: string
): Promise<string | null> {
  const row = await db
    .select({ name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .get();
  return row ? viaName(row.name) : null;
}
