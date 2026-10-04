import { createAuthClient } from 'better-auth/react';
import { adminClient, usernameClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  // Sign-in during an OAuth flow carries the signed authorization request.
  plugins: [adminClient(), usernameClient(), oauthProviderClient()],
});

export const { useSession, signIn, signOut } = authClient;

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  username?: string;
  displayUsername?: string;
  role?: string;
  image?: string | null;
};

export function useCurrentUser(): CurrentUser | null {
  const { data } = useSession();
  return (data?.user as CurrentUser) ?? null;
}
