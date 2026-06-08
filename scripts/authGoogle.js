// scripts/authGoogle.js
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { google } from "googleapis";
import { loadDotEnv } from "../src/config.js";

loadDotEnv();

const clientId = process.env.GOOGLE_AGENT_CLIENT_ID;
const clientSecret = process.env.GOOGLE_AGENT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_AGENT_CLIENT_ID and GOOGLE_AGENT_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
const scopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.send"];
const authUrl = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: scopes });

console.log("1) Open this URL while logged in as the dedicated agent Google account:\n");
console.log(authUrl, "\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("2) Paste the authorization code here: ")).trim();
rl.close();

const { tokens } = await oauth2.getToken(code);

if (!tokens.refresh_token) {
  console.error(
    "\nERROR: Google did not return a refresh token.\n" +
    "This happens when the app already has offline access granted.\n" +
    "To fix: go to https://myaccount.google.com/permissions, revoke access for this app, then re-run this script."
  );
  process.exit(1);
}

const envKey = "GOOGLE_AGENT_REFRESH_TOKEN";
const envLine = `${envKey}=${tokens.refresh_token}`;
const envPath = path.resolve(process.cwd(), ".env");

console.log(
  "\n╔══════════════════════════════════════════════════════════════╗\n" +
  "║  SECURITY WARNING — REFRESH TOKEN                           ║\n" +
  "║  This token grants permanent offline access to Calendar     ║\n" +
  "║  and Gmail for the agent account.                           ║\n" +
  "║  • Treat it like a password — never share or commit it.     ║\n" +
  "║  • Do not paste it in shared terminals or chat logs.        ║\n" +
  "╚══════════════════════════════════════════════════════════════╝\n"
);

if (fs.existsSync(envPath)) {
  // Read existing .env and replace or append the key
  const existing = fs.readFileSync(envPath, "utf8");
  const keyPattern = new RegExp(`^${envKey}=.*$`, "m");
  let updated;
  if (keyPattern.test(existing)) {
    updated = existing.replace(keyPattern, envLine);
  } else {
    updated = existing.endsWith("\n") ? existing + envLine + "\n" : existing + "\n" + envLine + "\n";
  }
  fs.writeFileSync(envPath, updated, "utf8");
  console.log(`Refresh token written to ${envPath} as ${envKey}.`);
  console.log("Verify the entry is correct, then restrict file permissions if needed (e.g. chmod 600 .env).");
} else {
  console.log("No .env file found in the current directory. Add the following line to your .env manually:\n");
  console.log(`  ${envLine}\n`);
}

console.log(
  "\nREMINDER: If the token was printed to your terminal, clear your shell history:\n" +
  "  • bash:  history -c && history -w\n" +
  "  • zsh:   fc -p && history -p\n" +
  "  Or scroll up and confirm no sensitive value remains on-screen."
);
