// scripts/authGoogle.js
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
console.log("\nAdd this to .env:\n");
console.log(`GOOGLE_AGENT_REFRESH_TOKEN=${tokens.refresh_token}`);
