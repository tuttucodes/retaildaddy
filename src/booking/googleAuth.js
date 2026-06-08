// src/booking/googleAuth.js
import { google } from "googleapis";

/**
 * Build an OAuth2 client authorized via the agent account's offline refresh token.
 * @param {{googleClientId: string, googleClientSecret: string, googleRefreshToken: string}} booking
 */
export function createGoogleAuth(booking) {
  const { googleClientId, googleClientSecret, googleRefreshToken } = booking;
  if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
    throw new Error("Missing Google agent credentials. Run npm run auth:google and set GOOGLE_AGENT_* env.");
  }
  const client = new google.auth.OAuth2(googleClientId, googleClientSecret, "urn:ietf:wg:oauth:2.0:oob");
  client.setCredentials({ refresh_token: googleRefreshToken });
  return client;
}
